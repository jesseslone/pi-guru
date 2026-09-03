/**
 * pi-guru-bench — the judge accuracy benchmark, a second extension entry.
 *
 * This extension stands entirely apart from the gate: it registers `/judge-bench` (subcommands
 * `run`, `compare`, `show`, `diff`, `sources`) and never listens on `tool_call`, so loading it
 * changes nothing about how pi-guru gates change calls. It measures how the *production* judge path
 * (`buildJudgeMessages` → `parseVerdict`, via `runJudge`) rates a corpus of harmful/benign change
 * calls, choosing the model ONLY through `ctx.modelRegistry` and writing every result to disk as it
 * goes.
 *
 * Model resolution (plan finding 8): default `ctx.model`; else a `provider/model` string or a unique
 * substring over the configured models; ambiguity errors with the candidates; a model without
 * configured auth is skipped with the same guard production uses. No provider config is read here.
 *
 * Cancellation (plan finding 2): `ctx.signal` is undefined outside an agent turn, so the runner owns
 * an `AbortController`. In a TUI a `ctx.ui.custom` overlay shows progress and aborts on Esc; in other
 * modes progress is printed as lines. The `pi -p` command path is verified in this slice; a
 * `judge-bench` start-up flag covers automation when print mode does not fire the slash command.
 */

import { join } from "node:path";
import { uuidv7 } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import { Box, Markdown, matchesKey, Text } from "@earendil-works/pi-tui";
import {
	FileCacheSink,
	formatCacheReport,
	layoutsLabel,
	makeCacheRunId,
} from "../src/bench/cache-results.ts";
import { type CacheMeta, type CacheProgress, CacheRunner } from "../src/bench/cache-runner.ts";
import { buildSyntheticSession } from "../src/bench/cache-session.ts";
import { loadSources } from "../src/bench/loader.ts";
import { RunLock, RunLockError } from "../src/bench/lock.ts";
import { modelLabel, resolveModel } from "../src/bench/model-resolve.ts";
import {
	formatReadingBlock,
	generateReading,
	type ReadingResult,
	readingFactsForCompare,
	readingFactsForRun,
	spokenOrNull,
} from "../src/bench/reading.ts";
import {
	appendReadingToReport,
	FileRunSink,
	formatCompare,
	formatDiff,
	formatRunReport,
	listRuns,
	makeRunId,
	readRun,
	repairRun,
	rescoreRun,
	retryUnavailable,
} from "../src/bench/results.ts";
import type { RunMeta, RunRecord, RunSummary } from "../src/bench/run-result.ts";
import { BenchRunner, type RunProgress } from "../src/bench/runner.ts";
import type { Expected } from "../src/bench/schema.ts";
import { ALL_SOURCES } from "../src/bench/sources/index.ts";
import { loadEffectiveConfig } from "../src/config.ts";
import type { JudgeLayout } from "../src/judge.ts";
import { JUDGE_PROMPT_VERSIONS, type JudgePromptVersion } from "../src/judge-prompt.ts";
import type { ExplanationLevel } from "../src/levels.ts";
import type { Completer } from "../src/model.ts";
import { notify } from "../src/notify.ts";

const DEFAULT_TIMEOUT_S = 60;
/** Passes allowed on `run`: 1, 3, or 9. */
const ALLOWED_PASSES = [1, 3, 9];
/** Fixed per-run nonce for `prefix-stable`'s transcript fence, so an accuracy run is deterministic. */
const RUN_SESSION_NONCE = "runbench";

/** The session-entry namespace for the bench's result entry (distinct from the gate's `pi-guru`). */
const ENTRY_PREFIX = "pi-guru-bench";

/** The result session entry: a run/cache report kept in scrollback, never entering model context. */
interface ResultEntry {
	kind: "run" | "cache";
	runId: string;
	markdown: string;
	/** The generated plain-language reading, when one was produced. */
	reading: { markdown: string } | null;
	/** A one-line note when the reading was suppressed or unavailable. */
	readingNote: string | null;
	timestamp: number;
}

export default function (pi: ExtensionAPI) {
	registerResultRenderer(pi);
	pi.registerCommand("judge-bench", {
		description:
			"Judge accuracy benchmark: /judge-bench run|compare|show|diff|repair|rescore|sources (model via the registry)",
		getArgumentCompletions: (prefix) =>
			["run", "cache", "compare", "show", "diff", "repair", "rescore", "sources"]
				.filter((s) => s.startsWith(prefix))
				.map((s) => ({ value: s, label: s })),
		handler: (args, ctx) => dispatch(pi, args, ctx),
	});

	// Start-up flag path for automation when `pi -p "/judge-bench …"` does not fire the command.
	// `pi -p --judge-bench "run --limit 2"` runs the same dispatch on session start.
	pi.registerFlag("judge-bench", {
		description: "Run the judge bench on start-up, e.g. --judge-bench 'run --limit 2 --sources hand-written'",
		type: "string",
	});
	pi.on("session_start", async (_event, ctx) => {
		const arg = pi.getFlag("judge-bench") as string | undefined;
		if (arg?.trim()) await dispatch(pi, arg, ctx);
	});
}

/** Route `<sub> <rest…>` to a subcommand; unknown subcommands report the usage line. */
async function dispatch(pi: ExtensionAPI, args: string, ctx: ExtensionContext): Promise<void> {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const sub = tokens[0] ?? "";
	const rest = tokens.slice(1);
	switch (sub) {
		case "run":
			return runBench(pi, ctx, rest);
		case "cache":
			return runCache(pi, ctx, rest);
		case "compare":
			return compareRuns(pi, ctx, rest);
		case "show":
			return showRun(pi, ctx, rest);
		case "diff":
			return diffRuns(ctx, rest);
		case "repair":
			return repairBench(ctx, rest);
		case "rescore":
			return rescoreBench(ctx, rest);
		case "sources":
			return listSources(ctx);
		default:
			notify(
				ctx,
				"pi-guru-bench: usage — /judge-bench run [provider/model] [--sources a,b] [--limit N] [--seed S] [--passes 1|3|9] [--layout current|prefix-stable|shared-prefix] [--prompt v1|v2] [--facts on|off] [--resume <run>] [--retry-unavailable] [--concurrency N] [--timeout S] | cache [provider/model] [--layout current|prefix-stable|shared-prefix|all] [--facts on|off] [--calls N] [--pad-tokens N] [--timeout S] | compare [--read] | show <run> | diff <a> <b> | repair <run> | rescore <run> | sources",
				"info",
			);
	}
}

/** The explanation level from pi-guru's config, via the production loader. */
function readLevel(): ExplanationLevel {
	const path = process.env.PI_GURU_CONFIG ?? join(getAgentDir(), "pi-guru.json");
	return loadEffectiveConfig(path).level;
}

/**
 * A reading completer on the session model, with production's options and the run's per-call
 * timeout. Null when there is no usable session model, which `generateReading` degrades to a note.
 */
function readingCompleter(
	ctx: ExtensionContext,
	model: NonNullable<ExtensionContext["model"]> | undefined,
	timeoutMs: number,
): Completer | null {
	if (!model) return null;
	return (context) =>
		ctx.modelRegistry.complete(model, context, {
			signal: AbortSignal.timeout(timeoutMs),
			reasoning: model.reasoning ? "low" : undefined,
			cacheRetention: "none",
			sessionId: uuidv7(),
		});
}

/** The session model, only when it exists and has configured auth (never a hard-coded model). */
function sessionModel(ctx: ExtensionContext) {
	const model = ctx.model;
	if (!model) return undefined;
	return ctx.modelRegistry.hasConfiguredAuth(model) ? model : undefined;
}

/** Append the `pi-guru-bench:result` session entry — UI-only, never entering model context. */
function appendResultEntry(
	pi: ExtensionAPI,
	kind: "run" | "cache",
	runId: string,
	markdown: string,
	reading: ReadingResult | null,
): void {
	pi.appendEntry<ResultEntry>(`${ENTRY_PREFIX}:result`, {
		kind,
		runId,
		markdown,
		reading: reading?.kind === "reading" ? { markdown: reading.markdown } : null,
		readingNote: reading && reading.kind !== "reading" ? reading.note : null,
		timestamp: Date.now(),
	});
}

/** Register the Markdown renderer for the result entry (the report tables + the reading). */
function registerResultRenderer(pi: ExtensionAPI): void {
	pi.registerEntryRenderer<ResultEntry>(`${ENTRY_PREFIX}:result`, (entry, { expanded }, theme) => {
		const data = entry.data;
		const header = data ? `${data.kind} result · ${data.runId}` : "result";
		const box = new Box(1, 0, (t) => theme.bg("customMessageBg", t));
		box.addChild(new Text(`${theme.fg("accent", "[pi-guru-bench]")} ${header}`, 0, 0));
		if (expanded && data) {
			box.addChild(new Markdown(data.markdown, 0, 0, getMarkdownTheme()));
			if (data.reading) {
				box.addChild(new Text(theme.fg("dim", "plain-language reading (generated):"), 0, 0));
				box.addChild(new Markdown(data.reading.markdown, 0, 0, getMarkdownTheme()));
			} else if (data.readingNote) {
				box.addChild(new Text(theme.fg("dim", data.readingNote), 0, 0));
			}
		}
		return box;
	});
}

/** Parsed `run` arguments: an optional model spec plus the recognised flags, or a usage error. */
interface RunArgs {
	model?: string;
	sources?: string[];
	limit?: number;
	seed: string;
	resume?: string;
	/** `--retry-unavailable`: on `--resume`, re-judge unavailable (recordId, pass) keys. */
	retryUnavailable: boolean;
	concurrency: number;
	timeoutMs: number;
	passes: number;
	layout: JudgeLayout;
	promptVersion: JudgePromptVersion;
	/** `--facts on|off` (default on): apply the deterministic facts block + floors. */
	facts: boolean;
}

/** Parse a `--facts on|off` flag, defaulting to on; returns a usage error string for anything else. */
function parseFactsFlag(raw: string | boolean | undefined): boolean | { error: string } {
	if (raw === undefined || raw === true) return true;
	const v = String(raw).trim().toLowerCase();
	if (v === "" || v === "on" || v === "true") return true;
	if (v === "off" || v === "false") return false;
	return { error: `unknown --facts '${raw}' (use on|off)` };
}

function parseRunArgs(rest: string[]): RunArgs | { error: string } {
	const { positionals, flags } = parseFlags(rest);
	const num = (v: string | boolean | undefined) =>
		typeof v === "string" && v.trim() !== "" ? Number(v) : undefined;
	const limit = num(flags.limit);
	const concurrency = num(flags.concurrency);

	const passesRaw = num(flags.passes);
	const passes = passesRaw === undefined ? 1 : passesRaw;
	if (!ALLOWED_PASSES.includes(passes)) {
		return { error: `--passes must be one of ${ALLOWED_PASSES.join(", ")} (got '${flags.passes}')` };
	}
	const layoutRaw = typeof flags.layout === "string" ? flags.layout.trim() : "current";
	if (!["current", "prefix-stable", "shared-prefix"].includes(layoutRaw)) {
		return { error: `unknown --layout '${layoutRaw}' (use current|prefix-stable|shared-prefix)` };
	}
	const promptRaw = typeof flags.prompt === "string" ? flags.prompt.trim() : "v1";
	if (!(JUDGE_PROMPT_VERSIONS as readonly string[]).includes(promptRaw)) {
		return { error: `unknown --prompt '${promptRaw}' (use ${JUDGE_PROMPT_VERSIONS.join("|")})` };
	}
	const facts = parseFactsFlag(flags.facts);
	if (typeof facts !== "boolean") return facts;
	return {
		model: positionals[0],
		sources:
			typeof flags.sources === "string"
				? flags.sources
						.split(",")
						.map((s) => s.trim())
						.filter(Boolean)
				: undefined,
		limit: limit !== undefined && Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : undefined,
		seed: typeof flags.seed === "string" && flags.seed.trim() !== "" ? flags.seed.trim() : "default",
		resume: typeof flags.resume === "string" ? flags.resume.trim() : undefined,
		retryUnavailable: flags["retry-unavailable"] === true || flags["retry-unavailable"] === "true",
		concurrency:
			concurrency !== undefined && Number.isFinite(concurrency) && concurrency > 0
				? Math.floor(concurrency)
				: 1,
		timeoutMs: parseTimeoutMs(num(flags.timeout)),
		passes,
		layout: layoutRaw as JudgeLayout,
		promptVersion: promptRaw as JudgePromptVersion,
		facts,
	};
}

/** Turn a `--timeout <seconds>` value into ms, defaulting to the production judge's 60 s. */
function parseTimeoutMs(seconds: number | undefined): number {
	return seconds !== undefined && Number.isFinite(seconds) && seconds > 0
		? Math.floor(seconds * 1000)
		: DEFAULT_TIMEOUT_S * 1000;
}

/** Split tokens into positionals and `--key[=value]` / `--key value` flags. */
function parseFlags(tokens: string[]): { positionals: string[]; flags: Record<string, string | boolean> } {
	const positionals: string[] = [];
	const flags: Record<string, string | boolean> = {};
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (!token.startsWith("--")) {
			positionals.push(token);
			continue;
		}
		const body = token.slice(2);
		const eq = body.indexOf("=");
		if (eq >= 0) {
			flags[body.slice(0, eq)] = body.slice(eq + 1);
			continue;
		}
		const next = tokens[i + 1];
		if (next !== undefined && !next.startsWith("--")) {
			flags[body] = next;
			i++;
		} else {
			flags[body] = true;
		}
	}
	return { positionals, flags };
}

async function runBench(pi: ExtensionAPI, ctx: ExtensionContext, rest: string[]): Promise<void> {
	const parsed = parseRunArgs(rest);
	if ("error" in parsed) {
		notify(ctx, `pi-guru-bench: ${parsed.error}`, "error");
		return;
	}
	if (parsed.retryUnavailable && !parsed.resume) {
		notify(ctx, "pi-guru-bench: --retry-unavailable only applies with --resume <run> — ignored", "warning");
	}

	// Resume continues an existing run with its recorded model/seed/limit/sources/passes/layout, so the
	// sample and checkpoint stay coherent; anything passed on the command line is ignored (with a note).
	let meta: RunMeta;
	let resume = false;
	if (parsed.resume) {
		let prior: ReturnType<typeof readRun>;
		try {
			prior = readRun(parsed.resume);
		} catch (err) {
			notify(ctx, `pi-guru-bench: ${(err as Error).message}`, "error");
			return;
		}
		resume = true;
		meta = { ...prior.summary, finished: null };
		// Older summaries predate `timeoutMs`/`passes`/`promptVersion`/`facts`; fill defaults for coherence.
		if (typeof meta.timeoutMs !== "number") meta.timeoutMs = parsed.timeoutMs;
		if (typeof meta.passes !== "number") meta.passes = 1;
		if (meta.promptVersion !== "v1" && meta.promptVersion !== "v2") meta.promptVersion = "v1";
		// A run started before the facts feature computed its verdicts without facts — keep it that way.
		if (typeof meta.facts !== "boolean") meta.facts = false;
		if (
			parsed.model ||
			rest.some(
				(t) =>
					t.startsWith("--seed") ||
					t.startsWith("--limit") ||
					t.startsWith("--sources") ||
					t.startsWith("--passes") ||
					t.startsWith("--layout") ||
					t.startsWith("--prompt") ||
					t.startsWith("--facts"),
			)
		) {
			notify(
				ctx,
				"pi-guru-bench: resume ignores model/seed/limit/sources/passes/layout/prompt/facts — continuing the original run",
				"info",
			);
		}
	} else {
		const resolved = resolveModel(
			ctx.modelRegistry.getAll(),
			(m) => ctx.modelRegistry.hasConfiguredAuth(m),
			parsed.model,
			ctx.model,
		);
		if (resolved.kind === "error") {
			notify(ctx, `pi-guru-bench: ${resolved.message}`, "error");
			return;
		}
		if (resolved.kind === "skip") {
			notify(ctx, `pi-guru-bench: ${resolved.message}`, "warning");
			return;
		}
		meta = {
			run: makeRunId(resolved.model, parsed.layout, parsed.promptVersion, parsed.facts),
			model: { provider: resolved.model.provider, id: resolved.model.id },
			layout: parsed.layout,
			promptVersion: parsed.promptVersion,
			facts: parsed.facts,
			seed: parsed.seed,
			limit: parsed.limit ?? null,
			passes: parsed.passes,
			sources: parsed.sources ?? "all",
			timeoutMs: parsed.timeoutMs,
			started: new Date().toISOString(),
			finished: null,
		};
	}

	// Resolve the completing model (from the resume's recorded model, or the freshly resolved one).
	const model = ctx.modelRegistry.find(meta.model.provider, meta.model.id);
	if (!model) {
		notify(ctx, `pi-guru-bench: model ${modelLabel(meta.model)} is not configured`, "error");
		return;
	}
	if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
		notify(ctx, `pi-guru-bench: ${modelLabel(meta.model)} has no configured auth — skipped`, "warning");
		return;
	}

	const makeCompleter = (signal: AbortSignal): Completer => {
		return (context) =>
			ctx.modelRegistry.complete(model, context, {
				signal,
				reasoning: model.reasoning ? "low" : undefined,
				cacheRetention: "none",
				sessionId: uuidv7(),
			});
	};

	// Take the per-run lock before any writer touches the JSONL: refuse if a live process already
	// holds this run (the #17 residual — two dispatches over one run), take over a stale (dead-pid)
	// lock, and drop it in the `finally` on a normal finish, an abort, or a throw.
	let lock: RunLock;
	try {
		lock = RunLock.acquire(meta.run);
	} catch (err) {
		if (err instanceof RunLockError) {
			notify(ctx, `pi-guru-bench: ${err.message}`, "error");
			return;
		}
		throw err;
	}

	try {
		// The overlay's render + Esc live in the `ctx.ui.custom` factory, which runs after the runner is
		// built; this local view bridges the two — `onProgress` updates it, the factory reads it.
		const view: ProgressView = { latest: null, requestRender: null };
		const only = meta.sources === "all" ? undefined : meta.sources;

		// --retry-unavailable: drop unavailable lines from the JSONL (keeping one .bak) BEFORE the sink
		// loads, so those (recordId, pass) keys read as not-done and this resume re-judges them.
		if (resume && parsed.retryUnavailable) {
			const { retried } = retryUnavailable(meta.run);
			notify(
				ctx,
				`pi-guru-bench: --retry-unavailable dropped ${retried} unavailable record(s) — they will be re-judged`,
				"info",
			);
		}

		const sink = new FileRunSink(meta.run, resume);
		const runner = new BenchRunner({
			meta,
			seed: meta.seed,
			limit: meta.limit ?? undefined,
			concurrency: parsed.concurrency,
			perCallTimeoutMs: meta.timeoutMs,
			layout: meta.layout,
			promptVersion: meta.promptVersion,
			sessionNonce: RUN_SESSION_NONCE,
			load: only ? { only } : {},
			makeCompleter,
			sink,
			onProgress: makeProgressReporter(ctx, view),
		});

		// The pid is printed so a launcher can track the writer and match it against `<run>.lock`.
		notify(
			ctx,
			`pi-guru-bench: ${resume ? "resuming" : "running"} ${meta.run} on ${modelLabel(meta.model)} (pid ${lock.info.pid}) — layout ${meta.layout}, prompt ${meta.promptVersion}, facts ${meta.facts ? "on" : "off"}, ${meta.passes} pass(es) (seed ${meta.seed}${meta.limit ? `, limit ${meta.limit}` : ""})`,
			"info",
		);

		const overlay = ctx.mode === "tui" ? openOverlay(ctx, runner, view) : null;
		let summary: RunSummary | null = null;
		try {
			summary = await runner.run();
			notify(
				ctx,
				`pi-guru-bench: ${runner.signal.aborted ? "aborted" : "done"} — ${summary.total} records, report at ${meta.run}.md`,
				runner.signal.aborted ? "warning" : "info",
			);
		} finally {
			overlay?.close();
			if (overlay) await overlay.promise;
		}

		// The reading is one extra model call after the run — guarded, at the config level, over the
		// summary numbers only, and appended to the report and the result entry (never model context).
		const report = formatRunReport(summary, sink.allRecords());
		const reading = await readForRun(ctx, summary, meta.timeoutMs);
		if (reading) appendReadingToReport(meta.run, formatReadingBlock(reading));
		appendResultEntry(pi, "run", meta.run, report, reading);
		if (ctx.mode !== "tui") {
			printLines(report);
			if (reading) printLines(formatReadingBlock(reading));
		}
	} finally {
		lock.release();
	}
}

/** Generate the guarded reading for one accuracy run, or null when the level is `off`. */
async function readForRun(
	ctx: ExtensionContext,
	summary: RunSummary,
	timeoutMs: number,
): Promise<ReadingResult | null> {
	const level = spokenOrNull(readLevel());
	if (!level) return null;
	return generateReading({
		level,
		facts: readingFactsForRun(summary),
		complete: readingCompleter(ctx, sessionModel(ctx), timeoutMs),
	});
}

// ---------------------------------------------------------------------------
// cache — the synthetic-session cache benchmark.
// ---------------------------------------------------------------------------

const ALL_LAYOUTS: JudgeLayout[] = ["current", "prefix-stable", "shared-prefix"];
const DEFAULT_CACHE_CALLS = 12;
const CACHE_PASSES = 2;
/** Fixed per-run session nonce so `prefix-stable`'s fenced transcript is byte-stable across passes. */
const CACHE_SESSION_NONCE = "cachebench";

/** Parsed `cache` arguments, or a usage error. */
interface CacheArgs {
	model?: string;
	layout: JudgeLayout | "all";
	calls: number;
	timeoutMs: number;
	padTokens: number;
	/** `--facts on|off` (default on): send the deterministic facts block with each judged call . */
	facts: boolean;
}

function parseCacheArgs(rest: string[]): CacheArgs | { error: string } {
	const { positionals, flags } = parseFlags(rest);
	const layoutRaw = typeof flags.layout === "string" ? flags.layout.trim() : "all";
	if (!["current", "prefix-stable", "shared-prefix", "all"].includes(layoutRaw)) {
		return { error: `unknown --layout '${layoutRaw}' (use current|prefix-stable|shared-prefix|all)` };
	}
	const facts = parseFactsFlag(flags.facts);
	if (typeof facts !== "boolean") return facts;
	const posInt = (v: string | boolean | undefined, fallback: number) => {
		const n = typeof v === "string" && v.trim() !== "" ? Number(v) : undefined;
		return n !== undefined && Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
	};
	const timeoutNum =
		typeof flags.timeout === "string" && flags.timeout.trim() !== "" ? Number(flags.timeout) : undefined;
	return {
		model: positionals[0],
		layout: layoutRaw as CacheArgs["layout"],
		calls: posInt(flags.calls, DEFAULT_CACHE_CALLS),
		timeoutMs: parseTimeoutMs(timeoutNum),
		// --pad-tokens N: grow the synthetic session's early transcript to ~N tokens (default 0).
		padTokens: posInt(flags["pad-tokens"], 0),
		facts,
	};
}

async function runCache(pi: ExtensionAPI, ctx: ExtensionContext, rest: string[]): Promise<void> {
	const parsed = parseCacheArgs(rest);
	if ("error" in parsed) {
		notify(ctx, `pi-guru-bench: ${parsed.error}`, "error");
		return;
	}

	const resolved = resolveModel(
		ctx.modelRegistry.getAll(),
		(m) => ctx.modelRegistry.hasConfiguredAuth(m),
		parsed.model,
		ctx.model,
	);
	if (resolved.kind === "error") {
		notify(ctx, `pi-guru-bench: ${resolved.message}`, "error");
		return;
	}
	if (resolved.kind === "skip") {
		notify(ctx, `pi-guru-bench: ${resolved.message}`, "warning");
		return;
	}
	const model = resolved.model;

	// Build the synthetic session from our own hand-written cases (offline; nothing third-party is
	// replayed). Ordered by id so the session is deterministic across machines.
	const { records } = await loadSources({ only: ["hand-written"] });
	if (records.length === 0) {
		notify(ctx, "pi-guru-bench: no hand-written cases to build a session from", "error");
		return;
	}
	const ordered = [...records].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const session = buildSyntheticSession(ordered, parsed.calls, { padTokens: parsed.padTokens });
	const layouts: JudgeLayout[] = parsed.layout === "all" ? ALL_LAYOUTS : [parsed.layout];

	const makeCompleter = (signal: AbortSignal): Completer => {
		return (context) =>
			ctx.modelRegistry.complete(model, context, {
				signal,
				reasoning: model.reasoning ? "low" : undefined,
				cacheRetention: "none",
				sessionId: uuidv7(),
			});
	};

	const meta: CacheMeta = {
		run: makeCacheRunId(model, layouts, parsed.facts),
		model: { provider: model.provider, id: model.id },
		layouts,
		passes: CACHE_PASSES,
		calls: session.steps.length,
		facts: parsed.facts,
		padTokens: parsed.padTokens,
		timeoutMs: parsed.timeoutMs,
		started: new Date().toISOString(),
		finished: null,
	};
	// A cache run is a fresh id each time, but it takes the same per-run lock so nothing else can
	// write this id and it is cleaned up on any exit.
	let lock: RunLock;
	try {
		lock = RunLock.acquire(meta.run);
	} catch (err) {
		if (err instanceof RunLockError) {
			notify(ctx, `pi-guru-bench: ${err.message}`, "error");
			return;
		}
		throw err;
	}

	try {
		const sink = new FileCacheSink(meta.run);
		const view: CacheProgressView = { latest: null, requestRender: null };
		const runner = new CacheRunner({
			meta,
			layouts,
			passes: CACHE_PASSES,
			session,
			sessionNonce: CACHE_SESSION_NONCE,
			perCallTimeoutMs: parsed.timeoutMs,
			makeCompleter,
			sink,
			onProgress: makeCacheProgress(ctx, view),
		});

		notify(
			ctx,
			`pi-guru-bench: cache ${meta.run} on ${modelLabel(meta.model)} (pid ${lock.info.pid}) — layouts ${layoutsLabel(layouts)}, facts ${meta.facts ? "on" : "off"}, ${session.steps.length} calls × ${CACHE_PASSES} passes, pad-tokens ${parsed.padTokens}`,
			"info",
		);

		const overlay = ctx.mode === "tui" ? openCacheOverlay(ctx, runner, view) : null;
		let summary: Awaited<ReturnType<CacheRunner["run"]>> | null = null;
		try {
			summary = await runner.run();
			notify(
				ctx,
				`pi-guru-bench: ${runner.signal.aborted ? "aborted" : "done"} — report at ${meta.run}.md`,
				runner.signal.aborted ? "warning" : "info",
			);
		} finally {
			overlay?.close();
			if (overlay) await overlay.promise;
		}

		// The cache report is per-layout latency/cache signal, not scored rates, so it carries no
		// reading (the reading is over rates with N and intervals); the result entry keeps it in scrollback.
		const report = formatCacheReport(summary);
		appendResultEntry(pi, "cache", meta.run, report, null);
		if (ctx.mode !== "tui") printLines(report);
	} finally {
		lock.release();
	}
}

/** Shared progress state between the cache `onProgress` and its overlay factory. */
interface CacheProgressView {
	latest: CacheProgress | null;
	requestRender: (() => void) | null;
}

/** Build the cache progress callback: update shared state, refresh the overlay, or print a line. */
function makeCacheProgress(ctx: ExtensionContext, view: CacheProgressView) {
	return (progress: CacheProgress) => {
		view.latest = progress;
		if (ctx.mode === "tui") {
			view.requestRender?.();
		} else {
			const r = progress.last;
			const verdict = r.available && r.risk ? r.risk : `unavailable(${r.error ?? "?"})`;
			const cached = r.cachedTokens === null ? "cache?" : `cached ${r.cachedTokens}`;
			printLines(
				`[${progress.done}/${progress.total}] ${r.layout} p${r.pass} call ${r.call} → ${verdict} (${r.latencyMs} ms, ${cached})`,
			);
		}
	};
}

/** Open the TUI cache overlay; Esc aborts the runner. Returns a closer + its promise. */
function openCacheOverlay(
	ctx: ExtensionContext,
	runner: CacheRunner,
	view: CacheProgressView,
): { close: () => void; promise: Promise<void> } {
	let close: () => void = () => {};
	const promise = ctx.ui.custom<void>(
		(tui, theme, _kb, done) => {
			close = () => done();
			view.requestRender = () => tui.requestRender();
			return {
				render: () =>
					cacheProgressLines(view.latest, runner.signal.aborted).map((l) => theme.fg("accent", l)),
				invalidate: () => {},
				handleInput: (data: string) => {
					if (matchesKey(data, "escape")) {
						runner.abort();
						tui.requestRender();
					}
				},
			};
		},
		{ overlay: true },
	);
	return { close, promise };
}

/** The lines the cache overlay renders from the latest progress. */
function cacheProgressLines(progress: CacheProgress | null, aborted: boolean): string[] {
	if (!progress) return ["pi-guru-bench cache: starting…", "esc cancels"];
	const r = progress.last;
	return [
		`pi-guru-bench cache ${aborted ? "(aborting…)" : "running"} — ${progress.done}/${progress.total}`,
		`  last: ${r.layout} pass ${r.pass} call ${r.call} — ${r.latencyMs} ms${r.cachedTokens === null ? "" : `, cached ${r.cachedTokens}`}`,
		"esc cancels — results are checkpointed to disk as they complete",
	];
}

/** Shared progress state between `onProgress` and the overlay factory for one run. */
interface ProgressView {
	latest: RunProgress | null;
	requestRender: (() => void) | null;
}

/** Build the progress callback: update shared state, refresh the overlay, or print a line. */
function makeProgressReporter(ctx: ExtensionContext, view: ProgressView) {
	return (progress: RunProgress) => {
		view.latest = progress;
		if (ctx.mode === "tui") {
			view.requestRender?.();
		} else {
			const r = progress.lastRecord;
			const verdict = r.available && r.risk ? r.risk : `unavailable(${r.error ?? "?"})`;
			printLines(
				`[${progress.done}/${progress.total}] ${r.source} ${r.recordId} → ${verdict} (${r.latencyMs} ms)`,
			);
		}
	};
}

/** Open the TUI progress overlay; Esc aborts the runner. Returns a closer + its promise. */
function openOverlay(
	ctx: ExtensionContext,
	runner: BenchRunner,
	view: ProgressView,
): { close: () => void; promise: Promise<void> } {
	let close: () => void = () => {};
	const promise = ctx.ui.custom<void>(
		(tui, theme, _kb, done) => {
			close = () => done();
			view.requestRender = () => tui.requestRender();
			return {
				render: () => progressLines(view.latest, runner.signal.aborted).map((l) => theme.fg("accent", l)),
				invalidate: () => {},
				handleInput: (data: string) => {
					if (matchesKey(data, "escape")) {
						runner.abort();
						tui.requestRender();
					}
				},
			};
		},
		{ overlay: true },
	);
	return { close, promise };
}

/** The lines the overlay renders from the latest progress. */
function progressLines(progress: RunProgress | null, aborted: boolean): string[] {
	if (!progress) return ["pi-guru-bench: starting…", "esc cancels"];
	const lines = [
		`pi-guru-bench ${aborted ? "(aborting…)" : "running"} — ${progress.done}/${progress.total} records`,
	];
	for (const s of progress.summary.perSource) {
		lines.push(
			`  ${s.source}: n=${s.n}  ≤med ${fmtPct(s.letThroughMedium)}  benign-blocked ${fmtPct(s.benignBlocked)}  unavail ${fmtPct(s.unavailableRate)}`,
		);
	}
	lines.push("esc cancels — results are checkpointed to disk as they complete");
	return lines;
}

function fmtPct(value: number | null): string {
	return value === null ? "—" : `${(value * 100).toFixed(0)}%`;
}

async function compareRuns(pi: ExtensionAPI, ctx: ExtensionContext, rest: string[]): Promise<void> {
	const { flags } = parseFlags(rest);
	const runs = listRuns();
	const table = formatCompare(runs);
	// `--read` runs the same guarded reading over the comparison table.
	let reading: ReadingResult | null = null;
	if (flags.read === true || flags.read === "true") {
		const level = spokenOrNull(readLevel());
		if (!level) {
			notify(ctx, "pi-guru-bench: explanation level is off — no reading produced", "info");
		} else {
			reading = await generateReading({
				level,
				facts: readingFactsForCompare(runs),
				complete: readingCompleter(ctx, sessionModel(ctx), DEFAULT_TIMEOUT_S * 1000),
			});
		}
	}
	appendResultEntry(pi, "run", "compare", table, reading);
	if (ctx.mode === "tui") {
		notify(ctx, table, "info");
	} else {
		printLines(table);
		if (reading) printLines(formatReadingBlock(reading));
	}
}

function showRun(pi: ExtensionAPI, ctx: ExtensionContext, rest: string[]): void {
	const ref = rest[0];
	if (!ref) {
		notify(ctx, "pi-guru-bench: usage — /judge-bench show <run>", "info");
		return;
	}
	try {
		const run = readRun(ref);
		const report = formatRunReport(run.summary, run.records);
		// `show` renders the tables only — no model call (nothing enters model context, the design notes item 1).
		appendResultEntry(pi, "run", run.summary.run, report, null);
		emitReport(ctx, report);
	} catch (err) {
		notify(ctx, `pi-guru-bench: ${(err as Error).message}`, "error");
	}
}

function diffRuns(ctx: ExtensionContext, rest: string[]): void {
	if (rest.length < 2) {
		notify(ctx, "pi-guru-bench: usage — /judge-bench diff <a> <b>", "info");
		return;
	}
	try {
		const a = readRun(rest[0]);
		const b = readRun(rest[1]);
		emitReport(ctx, formatDiff(a, b));
	} catch (err) {
		notify(ctx, `pi-guru-bench: ${(err as Error).message}`, "error");
	}
}

/** `repair <run>`: drop `/undefined` ids and duplicate (recordId, pass) lines, rewrite the summary. */
function repairBench(ctx: ExtensionContext, rest: string[]): void {
	const ref = rest[0];
	if (!ref) {
		notify(ctx, "pi-guru-bench: usage — /judge-bench repair <run>", "info");
		return;
	}
	try {
		const result = repairRun(ref);
		const removed = result.removedDuplicates + result.removedUndefined;
		const summary =
			`pi-guru-bench: repaired ${result.run} — removed ${removed} line(s) ` +
			`(${result.removedDuplicates} duplicate (recordId,pass), ${result.removedUndefined} /undefined id), ` +
			`kept ${result.kept}; rewrote summary.json and ${result.run}.md`;
		emitReport(ctx, summary);
	} catch (err) {
		notify(ctx, `pi-guru-bench: ${(err as Error).message}`, "error");
	}
}

/**
 * Recompute a record's expected label from its id via the owning source's `expectedForId` (issue
 * #22). A source without that hook, or one that returns undefined for this id, keeps the record's
 * stored label — so only id-derivable sources (RedCode) move.
 */
function resolveExpectedFromSources(record: RunRecord): Expected {
	const source = ALL_SOURCES.find((s) => s.id === record.source);
	return source?.expectedForId?.(record.recordId) ?? record.expected;
}

/** `rescore <run>`: re-apply the current converters' expected labels to a JSONL, rewrite the report. */
function rescoreBench(ctx: ExtensionContext, rest: string[]): void {
	const ref = rest[0];
	if (!ref) {
		notify(ctx, "pi-guru-bench: usage — /judge-bench rescore <run>", "info");
		return;
	}
	try {
		const result = rescoreRun(ref, resolveExpectedFromSources);
		emitReport(
			ctx,
			`pi-guru-bench: rescored ${result.run} — relabelled ${result.changed} of ${result.total} record(s) ` +
				`from the current converters; rewrote summary.json and ${result.run}.md`,
		);
	} catch (err) {
		notify(ctx, `pi-guru-bench: ${(err as Error).message}`, "error");
	}
}

function listSources(ctx: ExtensionContext): void {
	const lines = ["pi-guru-bench sources:"];
	for (const s of ALL_SOURCES) {
		lines.push(
			`- ${s.id} (${s.license})${s.enabledByDefault ? "" : " [off by default — licence unconfirmed]"}`,
		);
	}
	emitReport(ctx, lines.join("\n"));
}

/** Show a Markdown report: a scrollable overlay in a TUI, printed lines otherwise. */
function emitReport(ctx: ExtensionContext, markdown: string): void {
	if (ctx.mode === "tui") {
		notify(ctx, markdown, "info");
	} else {
		printLines(markdown);
	}
}

/** Print to stdout for non-TUI modes (print/json/rpc), where overlays and notify do not render. */
function printLines(text: string): void {
	process.stdout.write(`${text}\n`);
}
