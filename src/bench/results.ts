/**
 * The results store and report rendering.
 *
 * Every run keeps three files under `<benchDir>/results/`: `<run>.jsonl` (a `source-failed` line per
 * broken source, then a `record` line per judged record), `<run>.summary.json` (the derived summary,
 * rewritten after every record), and `<run>.md` (the same report as Markdown, written beside the
 * JSONL so results survive a crashed UI). `compare`/`show`/`diff` read these back. Nothing is written
 * under the repo; `PI_GURU_BENCH_DIR` relocates the whole tree and every test points it at a temp dir.
 *
 * Reports are per source and never pool a headline rate across sources (finding 6). `show` renders a
 * 3×3 authored-risk-vs-verdict matrix only for the hand-written source, the one source that carries a
 * three-way authored label (finding 4).
 */

import {
	appendFileSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { benchDir } from "./cache.ts";
import {
	computeSummary,
	type MajorityLabel,
	majorityVerdict,
	type RunLine,
	type RunMeta,
	type RunRecord,
	type RunSummary,
	type SourceSummary,
} from "./run-result.ts";
import { passKey, type RunSink } from "./runner.ts";
import type { Expected } from "./schema.ts";

/** The results directory: `<benchDir>/results/`. */
export function resultsDir(): string {
	return join(benchDir(), "results");
}

/** Keep a run id usable as one filename segment. */
function safe(segment: string): string {
	return segment.replace(/[^A-Za-z0-9._-]/g, "-");
}

/** Build a stable, filesystem-safe run id from the model, layout, prompt version, facts, and a timestamp. */
export function makeRunId(
	model: { provider: string; id: string },
	layout: string,
	promptVersion: string,
	facts: boolean,
	when: Date = new Date(),
): string {
	const stamp = safe(when.toISOString());
	const factsSeg = facts ? "factson" : "factsoff";
	return `${stamp}-${safe(model.provider)}_${safe(model.id)}-${safe(layout)}-${safe(promptVersion)}-${factsSeg}`;
}

function jsonlPath(runId: string): string {
	return join(resultsDir(), `${runId}.jsonl`);
}
function summaryPath(runId: string): string {
	return join(resultsDir(), `${runId}.summary.json`);
}
function reportPath(runId: string): string {
	return join(resultsDir(), `${runId}.md`);
}

/**
 * A file-backed `RunSink`. The JSONL is created (touched) on construction — before the first model
 * call — and every append is flushed immediately. `resume` loads any existing records so the summary
 * stays whole and `doneRecordIds()` skips finished work.
 */
export class FileRunSink implements RunSink {
	private readonly records: RunRecord[] = [];
	private readonly failures: { source: string; reason: string }[] = [];
	private readonly failedSources = new Set<string>();

	constructor(
		private readonly runId: string,
		resume = false,
	) {
		mkdirSync(resultsDir(), { recursive: true });
		const path = jsonlPath(runId);
		if (resume && existsSync(path)) {
			this.load(path);
		} else {
			writeFileSync(path, ""); // create before the first call (plan: checkpoint before first)
		}
	}

	private load(path: string): void {
		for (const parsed of parseJsonl(readFileSync(path, "utf8"))) {
			if (parsed.type === "record") {
				const { type: _type, ...record } = parsed;
				// Older JSONL predates per-pass lines; treat a missing pass as pass 1.
				if (typeof record.pass !== "number") record.pass = 1;
				this.records.push(record);
			} else if (parsed.type === "source-failed" && !this.failedSources.has(parsed.source)) {
				this.failedSources.add(parsed.source);
				this.failures.push({ source: parsed.source, reason: parsed.reason });
			}
		}
	}

	appendSourceFailed(line: { source: string; reason: string }): void {
		if (this.failedSources.has(line.source)) return; // dedupe across a resume
		this.failedSources.add(line.source);
		this.failures.push({ source: line.source, reason: line.reason });
		appendFileSync(jsonlPath(this.runId), `${JSON.stringify({ type: "source-failed", ...line })}\n`);
	}

	appendRecord(record: RunRecord): void {
		this.records.push(record);
		appendFileSync(jsonlPath(this.runId), `${JSON.stringify({ type: "record", ...record })}\n`);
	}

	writeSummary(summary: RunSummary): void {
		writeFileSync(summaryPath(this.runId), `${JSON.stringify(summary, null, 2)}\n`);
		writeFileSync(reportPath(this.runId), formatRunReport(summary, this.records));
	}

	allRecords(): RunRecord[] {
		return this.records;
	}
	sourceFailures(): { source: string; reason: string }[] {
		return this.failures;
	}
	/**
	 * The keys already judged, read **live from disk** — not just this sink's in-memory records. A
	 * second dispatch resuming the same run appends to the same JSONL while this one runs; reading
	 * the file each call lets the runner's guard see those commits and skip them, so the same
	 * (recordId, pass) is never judged twice across dispatches. Own in-memory records are
	 * unioned in so a not-yet-reread append still counts.
	 */
	doneKeys(): Set<string> {
		const keys = new Set(this.records.map((r) => passKey(r.recordId, r.pass)));
		const path = jsonlPath(this.runId);
		if (existsSync(path)) {
			for (const parsed of parseJsonl(readFileSync(path, "utf8"))) {
				if (parsed.type === "record") {
					keys.add(passKey(parsed.recordId, typeof parsed.pass === "number" ? parsed.pass : 1));
				}
			}
		}
		return keys;
	}
}

/**
 * Parse a JSONL blob into `RunLine`s, **tolerating** a truncated or malformed final line rather than
 * throwing. A run killed mid-write (the ~30-min print-mode cap) can leave a partial last line; a
 * resume that threw on it used to crash. Only well-formed lines are yielded.
 */
function parseJsonl(text: string): RunLine[] {
	const out: RunLine[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			out.push(JSON.parse(trimmed) as RunLine);
		} catch {
			// A partial/corrupt line (e.g. a truncated final write) is skipped, not fatal.
		}
	}
	return out;
}

/**
 * Append a Markdown block (the plain-language reading) to a run's `<run>.md`, after the run's final
 * summary write. The reading is generated once the run completes, so this is a single trailing
 * append — never racing the per-record report rewrites.
 */
export function appendReadingToReport(runId: string, block: string): void {
	const path = reportPath(runId);
	if (!existsSync(path)) return;
	appendFileSync(path, `\n${block}\n`);
}

/** One run's persisted state, read back from disk. */
export interface StoredRun {
	summary: RunSummary;
	records: RunRecord[];
}

/** All summaries on disk, newest first (by `started`). */
export function listRuns(): RunSummary[] {
	const dir = resultsDir();
	if (!existsSync(dir)) return [];
	const summaries: RunSummary[] = [];
	for (const name of readdirSync(dir).sort()) {
		if (!name.endsWith(".summary.json")) continue;
		try {
			summaries.push(JSON.parse(readFileSync(join(dir, name), "utf8")) as RunSummary);
		} catch {
			// A half-written or corrupt summary is skipped rather than sinking `compare`.
		}
	}
	return summaries.sort((a, b) => (a.started < b.started ? 1 : a.started > b.started ? -1 : 0));
}

/** Read one run's records (and source failures) from its JSONL. */
export function readRunRecords(runId: string): {
	records: RunRecord[];
	failures: { source: string; reason: string }[];
} {
	const records: RunRecord[] = [];
	const failures: { source: string; reason: string }[] = [];
	const path = jsonlPath(runId);
	if (!existsSync(path)) return { records, failures };
	for (const parsed of parseJsonl(readFileSync(path, "utf8"))) {
		if (parsed.type === "record") {
			const { type: _t, ...record } = parsed;
			if (typeof record.pass !== "number") record.pass = 1;
			records.push(record);
		} else if (parsed.type === "source-failed") {
			failures.push({ source: parsed.source, reason: parsed.reason });
		}
	}
	return { records, failures };
}

/** Resolve a run reference to an exact id, or a unique substring of the ids on disk. */
export function resolveRunId(ref: string): string {
	const ids = listRuns().map((s) => s.run);
	if (ids.includes(ref)) return ref;
	const matches = ids.filter((id) => id.includes(ref));
	if (matches.length === 1) return matches[0];
	if (matches.length === 0) throw new Error(`no run matches '${ref}'`);
	throw new Error(`'${ref}' is ambiguous — matches: ${matches.join(", ")}`);
}

/** Load one run (summary + records) by an exact or unique-substring reference. */
export function readRun(ref: string): StoredRun {
	const runId = resolveRunId(ref);
	const summaryFile = summaryPath(runId);
	const { records, failures } = readRunRecords(runId);
	const summary = existsSync(summaryFile)
		? (JSON.parse(readFileSync(summaryFile, "utf8")) as RunSummary)
		: computeSummary(placeholderMeta(runId), records, failures);
	return { summary, records };
}

/** Minimal meta when a summary file is missing — enough to recompute a report from the JSONL. */
function placeholderMeta(runId: string): RunMeta {
	return {
		run: runId,
		model: { provider: "?", id: "?" },
		layout: "current",
		promptVersion: "v1",
		facts: false,
		seed: "?",
		limit: null,
		passes: 1,
		sources: "all",
		timeoutMs: 60_000,
		started: "",
		finished: null,
	};
}

/** What `repair` removed from a run's JSONL. */
export interface RepairResult {
	run: string;
	/** Record lines kept (the first per `(recordId, pass)`, minus `/undefined` ids). */
	kept: number;
	/** Duplicate `(recordId, pass)` record lines dropped (second and later occurrences). */
	removedDuplicates: number;
	/** Record lines dropped because the id ends in `/undefined` (the collapsed-id bug). */
	removedUndefined: number;
}

/**
 * Repair a run's JSONL in place (the design notes item 5): keep the FIRST line per `(recordId, pass)`, drop
 * any record whose id ends in `/undefined`, then rewrite `summary.json` and `<run>.md` from what
 * survives. `source-failed` lines are preserved (first per source). Idempotent: a second run finds
 * nothing to remove and rewrites byte-identical files. Returns what it removed.
 */
export function repairRun(ref: string): RepairResult {
	const runId = resolveRepairRunId(ref);
	const path = jsonlPath(runId);
	if (!existsSync(path)) throw new Error(`no run matches '${ref}'`);

	const failures: { source: string; reason: string }[] = [];
	const failedSources = new Set<string>();
	const records: RunRecord[] = [];
	const seenKeys = new Set<string>();
	let removedDuplicates = 0;
	let removedUndefined = 0;

	for (const parsed of parseJsonl(readFileSync(path, "utf8"))) {
		if (parsed.type === "source-failed") {
			if (failedSources.has(parsed.source)) continue;
			failedSources.add(parsed.source);
			failures.push({ source: parsed.source, reason: parsed.reason });
			continue;
		}
		if (parsed.type !== "record") continue;
		const { type: _t, ...record } = parsed;
		if (typeof record.pass !== "number") record.pass = 1;
		if (record.recordId.endsWith("/undefined")) {
			removedUndefined++;
			continue;
		}
		const key = passKey(record.recordId, record.pass);
		if (seenKeys.has(key)) {
			removedDuplicates++;
			continue;
		}
		seenKeys.add(key);
		records.push(record);
	}

	// Rewrite the JSONL: source-failed lines first (as a fresh run writes them), then the kept records.
	const lines: string[] = [];
	for (const f of failures) lines.push(JSON.stringify({ type: "source-failed", ...f }));
	for (const r of records) lines.push(JSON.stringify({ type: "record", ...r }));
	writeFileSync(path, lines.length ? `${lines.join("\n")}\n` : "");

	// Rewrite the derived summary and Markdown from what survived, keeping the run's original meta.
	const meta = readMetaForRepair(runId);
	const summary = computeSummary(meta, records, failures);
	writeFileSync(summaryPath(runId), `${JSON.stringify(summary, null, 2)}\n`);
	writeFileSync(reportPath(runId), formatRunReport(summary, records));

	return { run: runId, kept: records.length, removedDuplicates, removedUndefined };
}

/** What `retryUnavailable` dropped from a run's JSONL so `--resume` re-judges it. */
export interface RetryUnavailableResult {
	run: string;
	/** Unavailable record lines removed — the (recordId, pass) keys a resume will re-judge. */
	retried: number;
	/** Available record lines kept. */
	kept: number;
}

/**
 * Drop every unavailable record line from a run's JSONL so `run --resume --retry-unavailable`
 * re-judges those (recordId, pass) keys instead of treating them as done. A single
 * `<run>.jsonl.bak` is kept the first time (never overwritten, so the original is preserved across
 * repeated retries), then the JSONL is rewritten with the source-failed lines and only the available
 * records, and `summary.json`/`<run>.md` are rewritten from the survivors. Returns what was removed.
 */
export function retryUnavailable(ref: string): RetryUnavailableResult {
	const runId = resolveRepairRunId(ref);
	const path = jsonlPath(runId);
	if (!existsSync(path)) throw new Error(`no run matches '${ref}'`);

	const failures: { source: string; reason: string }[] = [];
	const failedSources = new Set<string>();
	const kept: RunRecord[] = [];
	let retried = 0;

	for (const parsed of parseJsonl(readFileSync(path, "utf8"))) {
		if (parsed.type === "source-failed") {
			if (failedSources.has(parsed.source)) continue;
			failedSources.add(parsed.source);
			failures.push({ source: parsed.source, reason: parsed.reason });
			continue;
		}
		if (parsed.type !== "record") continue;
		const { type: _t, ...record } = parsed;
		if (typeof record.pass !== "number") record.pass = 1;
		if (!record.available) {
			retried++;
			continue;
		}
		kept.push(record);
	}

	if (retried === 0) return { run: runId, retried: 0, kept: kept.length };

	// Keep the original once — a repeated retry must not clobber the first backup.
	const bak = `${path}.bak`;
	if (!existsSync(bak)) copyFileSync(path, bak);

	const lines: string[] = [];
	for (const f of failures) lines.push(JSON.stringify({ type: "source-failed", ...f }));
	for (const r of kept) lines.push(JSON.stringify({ type: "record", ...r }));
	writeFileSync(path, lines.length ? `${lines.join("\n")}\n` : "");

	const meta = readMetaForRepair(runId);
	const summary = computeSummary(meta, kept, failures);
	writeFileSync(summaryPath(runId), `${JSON.stringify(summary, null, 2)}\n`);
	writeFileSync(reportPath(runId), formatRunReport(summary, kept));

	return { run: runId, retried, kept: kept.length };
}

/** What `rescore` changed in a run's JSONL. */
export interface RescoreResult {
	run: string;
	/** Record lines the run holds. */
	total: number;
	/** Record lines whose `expected` label the current converters changed. */
	changed: number;
}

/**
 * Re-apply the current converters' `expected` labels to an existing run's JSONL and rewrite its
 * `summary.json` + `<run>.md`. `resolveExpected` recomputes a record's expected purely
 * from its stored id (the owning source's `expectedForId`); a source whose expected is not
 * id-derivable returns the record's stored label unchanged. Nothing is judged — no model is called —
 * so the v1/v2/facts runs can be re-read after the RedCode split without any judging work. The JSONL is
 * rewritten with the source-failed lines first (as a fresh run writes them), then the records; a
 * second rescore with the same converters changes nothing. Returns how many labels moved.
 */
export function rescoreRun(ref: string, resolveExpected: (record: RunRecord) => Expected): RescoreResult {
	const runId = resolveRepairRunId(ref);
	const path = jsonlPath(runId);
	if (!existsSync(path)) throw new Error(`no run matches '${ref}'`);

	const failures: { source: string; reason: string }[] = [];
	const failedSources = new Set<string>();
	const records: RunRecord[] = [];
	for (const parsed of parseJsonl(readFileSync(path, "utf8"))) {
		if (parsed.type === "source-failed") {
			if (failedSources.has(parsed.source)) continue;
			failedSources.add(parsed.source);
			failures.push({ source: parsed.source, reason: parsed.reason });
			continue;
		}
		if (parsed.type !== "record") continue;
		const { type: _t, ...record } = parsed;
		if (typeof record.pass !== "number") record.pass = 1;
		records.push(record);
	}

	let changed = 0;
	for (const record of records) {
		const next = resolveExpected(record);
		if (next !== record.expected) {
			record.expected = next;
			changed++;
		}
	}

	const lines: string[] = [];
	for (const f of failures) lines.push(JSON.stringify({ type: "source-failed", ...f }));
	for (const r of records) lines.push(JSON.stringify({ type: "record", ...r }));
	writeFileSync(path, lines.length ? `${lines.join("\n")}\n` : "");

	const meta = readMetaForRepair(runId);
	const summary = computeSummary(meta, records, failures);
	writeFileSync(summaryPath(runId), `${JSON.stringify(summary, null, 2)}\n`);
	writeFileSync(reportPath(runId), formatRunReport(summary, records));

	return { run: runId, total: records.length, changed };
}

/** Resolve a repair target: an exact/unique run id, else an exact JSONL that has no summary yet. */
function resolveRepairRunId(ref: string): string {
	try {
		return resolveRunId(ref);
	} catch (err) {
		if (existsSync(jsonlPath(ref))) return ref; // a run whose summary is missing/corrupt
		throw err;
	}
}

/** The run's meta for a repair rewrite: its summary.json if present, else a placeholder. */
function readMetaForRepair(runId: string): RunMeta {
	const summaryFile = summaryPath(runId);
	if (existsSync(summaryFile)) {
		try {
			return JSON.parse(readFileSync(summaryFile, "utf8")) as RunMeta;
		} catch {
			// fall through to placeholder
		}
	}
	return placeholderMeta(runId);
}

// ---------------------------------------------------------------------------
// Markdown rendering. Per source, never a pooled headline (finding 6).
// ---------------------------------------------------------------------------

/** Format a fraction as a percent with one decimal, or `—` when the rate is undefined. */
function pct(value: number | null): string {
	return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

/** Format a latency in ms, or `—`. */
function ms(value: number | null): string {
	return value === null ? "—" : `${value} ms`;
}

/** Round a mean to a whole ms, preserving null. */
function round(value: number | null): number | null {
	return value === null ? null : Math.round(value);
}

/** The standing advisory both reports carry: the box is shared, so latency needs a quiet window. */
const SHARED_BOX_NOTE =
	"_Run on a shared GPU box, so every latency figure below is **advisory only** — read it in a quiet window or not at all; a busy engine is indistinguishable from a cache miss._";

/** Render a Markdown table from a header row and body rows. */
function table(header: string[], rows: string[][]): string {
	const head = `| ${header.join(" | ")} |`;
	const sep = `| ${header.map(() => "---").join(" | ")} |`;
	const body = rows.map((r) => `| ${r.join(" | ")} |`).join("\n");
	return rows.length ? `${head}\n${sep}\n${body}` : `${head}\n${sep}`;
}

/** The one-run report written to `<run>.md` and shown by `show`. */
export function formatRunReport(summary: RunSummary, records: RunRecord[]): string {
	const lines: string[] = [];
	const { provider, id } = summary.model;
	const observations = summary.perSource.reduce((n, s) => n + s.observations, 0);
	const distinctRecords = summary.perSource.reduce((n, s) => n + s.n, 0);
	lines.push(`# judge-bench run \`${summary.run}\``);
	lines.push("");
	lines.push(`- model: \`${provider}/${id}\``);
	lines.push(
		`- layout: \`${summary.layout}\`  ·  prompt: \`${summary.promptVersion ?? "v1"}\`  ·  facts: \`${summary.facts ? "on" : "off"}\``,
	);
	lines.push(
		`- seed: \`${summary.seed}\`  ·  limit: ${summary.limit ?? "none"}  ·  records: ${distinctRecords}  ·  passes: ${summary.passes}  ·  observations: ${observations}`,
	);
	lines.push(`- per-call timeout: ${(summary.timeoutMs / 1000).toFixed(0)} s`);
	lines.push(
		`- started: ${summary.started || "?"}  ·  finished: ${summary.finished ?? "(in progress / interrupted)"}`,
	);
	lines.push("");
	lines.push("Rates are **per source** — there is no pooled headline (a pool would be swamped by the");
	lines.push("largest source and mixes labels of different provenance).");
	lines.push("");
	lines.push(SHARED_BOX_NOTE);
	lines.push("");

	for (const s of summary.perSource) {
		lines.push(
			`## ${s.source}  ·  records=${s.n}  ·  observations=${s.observations}  ·  passes=${summary.passes}  ·  version \`${s.sourceVersion || "?"}\``,
		);
		lines.push("");
		lines.push("**Per-pass pooled** (each pass one independent observation):");
		lines.push("");
		const pooledRows: string[][] = [
			["let-through ≤low  (P risk≤low \\| harmful)", pct(s.letThroughLow), `n=${s.harmfulN} harmful obs`],
			[
				"let-through ≤medium  (P risk≤medium \\| harmful)",
				pct(s.letThroughMedium),
				`n=${s.harmfulN} harmful obs`,
			],
			["benign-blocked  (P risk=high \\| benign)", pct(s.benignBlocked), `n=${s.benignN} benign obs`],
		];
		// benign-for-gate: source-risky but harmless to the machine — its own row, never
		// a harmful let-through or a benign-blocked. Shown only when the source has such records.
		if ((s.benignForGateN ?? 0) > 0) {
			pooledRows.push([
				"benign-for-gate blocked  (P risk=high \\| benign-for-gate)",
				pct(s.benignForGateBlocked ?? null),
				`n=${s.benignForGateN} benign-for-gate obs`,
			]);
		}
		lines.push(table(["metric", "value", "denominator"], pooledRows));
		lines.push("");
		lines.push("**Per-record majority** (a record's passes collapsed to one verdict; ties/unavailable count");
		lines.push("as not-let-through and not-blocked):");
		lines.push("");
		const majorityRows: string[][] = [
			["let-through ≤low", pct(s.majorityLetThroughLow), `n=${s.majorityHarmfulN} harmful records`],
			["let-through ≤medium", pct(s.majorityLetThroughMedium), `n=${s.majorityHarmfulN} harmful records`],
			["benign-blocked", pct(s.majorityBenignBlocked), `n=${s.majorityBenignN} benign records`],
		];
		if ((s.majorityBenignForGateN ?? 0) > 0) {
			majorityRows.push([
				"benign-for-gate blocked",
				pct(s.majorityBenignForGateBlocked ?? null),
				`n=${s.majorityBenignForGateN} benign-for-gate records`,
			]);
		}
		lines.push(table(["metric", "value", "denominator"], majorityRows));
		lines.push("");
		lines.push(
			`- per-record agreement: ${pct(s.agreementRate)} (records whose ${summary.passes} passes all agreed)`,
		);
		lines.push(`- flips across the harmful/benign threshold (high ↔ not-high): ${s.flips} of ${s.n} records`);
		lines.push(
			`- latency (advisory): pass-1 mean ${ms(round(s.pass1LatencyMean))} vs later-pass mean ${ms(round(s.laterPassLatencyMean))}; p50/p95 ${ms(s.latencyP50)} / ${ms(s.latencyP95)}`,
		);
		lines.push(
			`- unavailable: ${pct(s.unavailableRate)} of ${s.observations} obs · ${s.unavailableTimeout} timeout, ${s.unavailableOther} other`,
		);
		if (summary.facts) {
			lines.push(
				`- deterministic floors (facts on): floored ${s.flooredMedium + s.flooredHigh} of ${s.observations} obs (medium ${s.flooredMedium}, high ${s.flooredHigh}); raised the model verdict on ${s.raised}`,
			);
		}
		lines.push("");
		lines.push(
			`verdict distribution (pooled; medium is a distribution, never scored): low ${s.verdictDist.low}, ` +
				`medium ${s.verdictDist.medium}, high ${s.verdictDist.high}, unavailable ${s.verdictDist.unavailable}`,
		);
		lines.push("");
		if (s.source === "hand-written") {
			lines.push(
				"authored risk vs. majority verdict (3×3, hand-written only — the source with an authored label):",
			);
			lines.push("");
			lines.push(confusionTable(records.filter((r) => r.source === "hand-written")));
			lines.push("");
		}
	}

	const unavailable = records.filter((r) => !r.available);
	if (unavailable.length) {
		lines.push("## unavailable records (raw model reply)");
		lines.push("");
		lines.push("Each record the judge could not rate, with its reason and the model's raw reply (empty when");
		lines.push("no reply was received, e.g. a timeout or a thrown error) — for diagnosing the cause.");
		lines.push("");
		for (const r of unavailable) {
			const reason = r.reason ?? r.error ?? "unavailable";
			lines.push(`- \`${r.recordId}\` pass ${r.pass} · ${r.source} — reason: ${reason}`);
			lines.push("");
			lines.push("  ```");
			for (const raw of (r.raw ?? "").split("\n")) lines.push(`  ${raw}`);
			lines.push("  ```");
		}
		lines.push("");
	}

	if (summary.sourceFailed.length) {
		lines.push("## sources that failed to load");
		lines.push("");
		for (const f of summary.sourceFailed) lines.push(`- \`${f.source}\`: ${f.reason}`);
		lines.push("");
	}
	return `${lines.join("\n")}\n`;
}

/**
 * The 3×3 authored-risk (rows) vs. majority-verdict (cols) matrix for the hand-written source. Each
 * record's passes are collapsed to their majority verdict first, so the matrix counts records, not
 * passes; a tie or all-unavailable record lands in the `unavailable/tie` column.
 */
function confusionTable(records: RunRecord[]): string {
	const byRecord = new Map<string, RunRecord[]>();
	const authoredOf = new Map<string, string | undefined>();
	for (const r of records) {
		const list = byRecord.get(r.recordId) ?? [];
		list.push(r);
		byRecord.set(r.recordId, list);
		authoredOf.set(r.recordId, r.authoredRisk);
	}
	const majorityOf = new Map<string, MajorityLabel>();
	for (const [recordId, passes] of byRecord) {
		majorityOf.set(recordId, majorityVerdict(passes.map((p) => (p.available ? p.risk : null))));
	}
	const risks: ("low" | "medium" | "high")[] = ["low", "medium", "high"];
	const rows = risks.map((authored) => {
		const ids = [...byRecord.keys()].filter((id) => authoredOf.get(id) === authored);
		const count = (v: MajorityLabel) => String(ids.filter((id) => majorityOf.get(id) === v).length);
		const other = String(
			ids.filter((id) => {
				const m = majorityOf.get(id);
				return m === "unavailable" || m === "tie";
			}).length,
		);
		return [`authored ${authored}`, count("low"), count("medium"), count("high"), other];
	});
	return table(["", "verdict low", "verdict medium", "verdict high", "unavailable/tie"], rows);
}

/**
 * `compare`: one row per (run, source) across all runs on disk. Reports both the per-pass pooled
 * rates and the per-record majority rates, plus the agreement rate, flip count, and the advisory
 * pass-1-vs-later latency split. Layout and passes are columns so a layout or passes
 * change is visible next to what it did to the numbers.
 */
export function formatCompare(summaries: RunSummary[]): string {
	if (summaries.length === 0) return "No runs recorded yet.";
	const rows: string[][] = [];
	for (const summary of summaries) {
		const model = `${summary.model.provider}/${summary.model.id}`;
		for (const s of summary.perSource) {
			rows.push([
				summary.run,
				model,
				summary.layout,
				summary.promptVersion ?? "v1",
				summary.facts ? "on" : "off",
				s.source,
				String(s.n),
				String(summary.passes),
				summary.seed,
				`${pct(s.letThroughLow)} / ${pct(s.majorityLetThroughLow)}`,
				`${pct(s.letThroughMedium)} / ${pct(s.majorityLetThroughMedium)}`,
				`${pct(s.benignBlocked)} / ${pct(s.majorityBenignBlocked)}`,
				(s.benignForGateN ?? 0) > 0
					? `${pct(s.benignForGateBlocked ?? null)} / ${pct(s.majorityBenignForGateBlocked ?? null)}`
					: "—",
				pct(s.agreementRate),
				String(s.flips),
				pct(s.unavailableRate),
				`${ms(round(s.pass1LatencyMean))} / ${ms(round(s.laterPassLatencyMean))}`,
				summary.started || "?",
			]);
		}
	}
	const header = [
		"run",
		"model",
		"layout",
		"prompt",
		"facts",
		"source",
		"records",
		"passes",
		"seed",
		"≤low (pool/maj)",
		"≤medium (pool/maj)",
		"benign-blocked (pool/maj)",
		"benign-for-gate blocked (pool/maj)",
		"agree",
		"flips",
		"unavailable",
		"pass1/later",
		"started",
	];
	return `# judge-bench compare (per source — no pooled headline)\n\n${SHARED_BOX_NOTE}\n\n${table(header, rows)}\n`;
}

/** One record rolled up for `diff`: its majority verdict and the per-pass vote breakdown. */
interface DiffRollup {
	expected: string;
	source: string;
	majority: MajorityLabel;
	/** A compact vote string, e.g. `low×2, high×1` — surfaces flips/agreement at the record level. */
	votes: string;
}

/** Group a run's pass-lines by record, keeping the majority verdict and the vote breakdown. */
function rollupForDiff(records: RunRecord[]): Map<string, DiffRollup> {
	const byRecord = new Map<string, RunRecord[]>();
	for (const r of records) {
		const list = byRecord.get(r.recordId) ?? [];
		list.push(r);
		byRecord.set(r.recordId, list);
	}
	const out = new Map<string, DiffRollup>();
	for (const [recordId, passes] of byRecord) {
		const tally: Record<string, number> = {};
		for (const p of passes) {
			const key = p.available && p.risk ? p.risk : "unavailable";
			tally[key] = (tally[key] ?? 0) + 1;
		}
		const votes = Object.entries(tally)
			.map(([k, n]) => `${k}×${n}`)
			.join(", ");
		out.set(recordId, {
			expected: passes[0].expected,
			source: passes[0].source,
			majority: majorityVerdict(passes.map((p) => (p.available ? p.risk : null))),
			votes,
		});
	}
	return out;
}

/**
 * `diff <a> <b>`: records present in both runs whose **majority verdict** disagrees. Each cell shows
 * the majority label and the per-pass vote breakdown, so a flip (passes straddling the threshold) is
 * visible even when the two runs' majorities happen to match.
 */
export function formatDiff(a: StoredRun, b: StoredRun): string {
	const rollA = rollupForDiff(a.records);
	const rollB = rollupForDiff(b.records);
	const rows: string[][] = [];
	for (const [recordId, ra] of rollA) {
		const rb = rollB.get(recordId);
		if (!rb) continue;
		if (ra.majority === rb.majority) continue;
		rows.push([
			recordId,
			ra.source,
			ra.expected,
			`${ra.majority} (${ra.votes})`,
			`${rb.majority} (${rb.votes})`,
		]);
	}
	const header = ["record", "source", "expected", `A: ${a.summary.run}`, `B: ${b.summary.run}`];
	const preamble =
		`# judge-bench diff (majority verdicts; cells show the per-pass vote breakdown)\n\n` +
		`- A = \`${a.summary.run}\` (${a.summary.model.provider}/${a.summary.model.id}, ${a.summary.passes} passes, layout ${a.summary.layout}, prompt ${a.summary.promptVersion ?? "v1"}, facts ${a.summary.facts ? "on" : "off"})\n` +
		`- B = \`${b.summary.run}\` (${b.summary.model.provider}/${b.summary.model.id}, ${b.summary.passes} passes, layout ${b.summary.layout}, prompt ${b.summary.promptVersion ?? "v1"}, facts ${b.summary.facts ? "on" : "off"})\n\n` +
		`${rows.length} of the shared records disagree.\n\n`;
	return `${preamble}${table(header, rows)}\n`;
}

/** A short one-line summary of a source's headline numbers, for `sources`/status. */
export function sourceLine(s: SourceSummary): string {
	return `${s.source}: n=${s.n}, ≤med ${pct(s.letThroughMedium)}, benign-blocked ${pct(s.benignBlocked)}`;
}
