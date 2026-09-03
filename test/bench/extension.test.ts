/**
 * Drives the real `extensions/pi-guru-bench.ts` entry — its command/flag registration and the
 * subcommand dispatch — with a fake `pi` and a fake `ctx`, so the wiring is exercised without the
 * `pi` binary and without a network or real model. (Whether `pi -p` itself routes a slash command to
 * a registered extension command is a pi-runtime behaviour verified separately; see bench-2-notes.md.)
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import benchExtension from "../../extensions/pi-guru-bench.ts";

interface Captured {
	commands: Record<string, { handler: (args: string, ctx: unknown) => unknown }>;
	flags: Record<string, unknown>;
	events: Record<string, (event: unknown, ctx: unknown) => unknown>;
	renderers: Record<string, unknown>;
	entries: { kind: string; data: unknown }[];
}

function fakePi(): Captured {
	const captured: Captured = { commands: {}, flags: {}, events: {}, renderers: {}, entries: [] };
	const pi = {
		registerCommand: (name: string, def: { handler: (a: string, c: unknown) => unknown }) => {
			captured.commands[name] = def;
		},
		registerFlag: (name: string, def: unknown) => {
			captured.flags[name] = def;
		},
		getFlag: () => undefined,
		on: (event: string, handler: (e: unknown, c: unknown) => unknown) => {
			captured.events[event] = handler;
		},
		registerEntryRenderer: (kind: string, renderer: unknown) => {
			captured.renderers[kind] = renderer;
		},
		appendEntry: (kind: string, data: unknown) => {
			captured.entries.push({ kind, data });
		},
	};
	// biome-ignore lint/suspicious/noExplicitAny: a minimal fake of the ExtensionAPI surface used here.
	benchExtension(pi as any);
	return captured;
}

/** A fake print-mode ctx; `notify` calls are captured, `complete` throws (no network in tests). */
function fakeCtx(models: { provider: string; id: string; reasoning?: boolean }[] = []) {
	const notifications: { message: string; type?: string }[] = [];
	const ctx = {
		mode: "print",
		hasUI: false,
		ui: {
			notify: (message: string, type?: string) => notifications.push({ message, type }),
			custom: async () => undefined,
		},
		modelRegistry: {
			getAll: () => models,
			hasConfiguredAuth: () => true,
			find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
			complete: async () => {
				throw new Error("no network in test");
			},
		},
		model: undefined,
	};
	return { ctx, notifications };
}

/** A print-mode ctx whose model is a fake session model that returns a low-risk verdict. */
function fakeCtxWithModel() {
	const model = { provider: "fake", id: "model", reasoning: false };
	const notifications: { message: string; type?: string }[] = [];
	const ctx = {
		mode: "print",
		hasUI: false,
		ui: {
			notify: (message: string, type?: string) => notifications.push({ message, type }),
			custom: async () => undefined,
		},
		modelRegistry: {
			getAll: () => [model],
			hasConfiguredAuth: () => true,
			find: (provider: string, id: string) =>
				provider === model.provider && id === model.id ? model : undefined,
			complete: async () => ({
				role: "assistant",
				content: [{ type: "text", text: '{"risk":"low","rationale":"ok"}' }],
				usage: {
					input: 10,
					output: 4,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 14,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			}),
		},
		model,
	};
	return { ctx, notifications };
}

/** Capture everything written to stdout during `fn`. */
async function captureStdout(fn: () => Promise<void> | void): Promise<string> {
	const chunks: string[] = [];
	const original = process.stdout.write.bind(process.stdout);
	// biome-ignore lint/suspicious/noExplicitAny: narrow stdout.write override for the test only.
	process.stdout.write = ((chunk: any) => {
		chunks.push(String(chunk));
		return true;
	}) as typeof process.stdout.write;
	try {
		await fn();
	} finally {
		process.stdout.write = original;
	}
	return chunks.join("");
}

let dir: string;
const prev = process.env.PI_GURU_BENCH_DIR;
const prevConfig = process.env.PI_GURU_CONFIG;
/** Point the config at a temp file with a chosen level, so the real `~/.pi` is never touched. */
function setLevel(level: string): void {
	const path = join(dir, "pi-guru.json");
	writeFileSync(path, JSON.stringify({ level }));
	process.env.PI_GURU_CONFIG = path;
}
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-guru-bench-ext-"));
	process.env.PI_GURU_BENCH_DIR = dir;
	setLevel("off"); // default off, so no reading model call unless a test opts in
});
afterEach(() => {
	if (prev === undefined) delete process.env.PI_GURU_BENCH_DIR;
	else process.env.PI_GURU_BENCH_DIR = prev;
	if (prevConfig === undefined) delete process.env.PI_GURU_CONFIG;
	else process.env.PI_GURU_CONFIG = prevConfig;
	rmSync(dir, { recursive: true, force: true });
});

describe("pi-guru-bench extension entry", () => {
	it("registers the /judge-bench command, the --judge-bench flag, and a session_start handler", () => {
		const captured = fakePi();
		expect(captured.commands["judge-bench"]).toBeDefined();
		expect(captured.flags["judge-bench"]).toBeDefined();
		expect(captured.events.session_start).toBeDefined();
	});

	it("dispatches `sources` to a printed list, including the off-by-default note", async () => {
		const captured = fakePi();
		const { ctx } = fakeCtx();
		const out = await captureStdout(async () => {
			await captured.commands["judge-bench"].handler("sources", ctx);
		});
		expect(out).toContain("redcode-exec");
		expect(out).toContain("off by default");
	});

	it("dispatches `repair` to rewrite a run's JSONL and prints what it removed", async () => {
		// Seed a run with a duplicate line and a collapsed /undefined id.
		const runId = "2026-repairable-current";
		const jsonl = join(dir, "results", `${runId}.jsonl`);
		mkdirSync(join(dir, "results"), { recursive: true });
		const line = (recordId: string, pass: number) =>
			`${JSON.stringify({
				type: "record",
				recordId,
				pass,
				source: "s",
				sourceVersion: "v",
				expected: "harmful",
				kind: "bash",
				category: "c",
				available: true,
				risk: "high",
				rationale: "x",
				latencyMs: 1,
				promptTokens: 1,
				cachedTokens: 0,
				error: null,
			})}\n`;
		writeFileSync(jsonl, line("s/1", 1) + line("s/1", 1) + line("rogue/undefined", 1));

		const captured = fakePi();
		const { ctx } = fakeCtx();
		const out = await captureStdout(async () => {
			await captured.commands["judge-bench"].handler(`repair ${runId}`, ctx);
		});
		expect(out).toContain("repaired");
		expect(out).toContain("1 duplicate");
		expect(out).toContain("1 /undefined");
		// only the first s/1#1 survives.
		expect(readFileSync(jsonl, "utf8").trim().split("\n")).toHaveLength(1);
	});

	it("dispatches `rescore` to re-apply the current converters' expected labels", async () => {
		// Seed a pre-split run: a redcode code-weakness record stored `harmful`, plus a non-redcode record.
		const runId = "2026-rescorable-current";
		const results = join(dir, "results");
		mkdirSync(results, { recursive: true });
		const line = (recordId: string, source: string, expected: string) =>
			`${JSON.stringify({
				type: "record",
				recordId,
				pass: 1,
				source,
				sourceVersion: "v",
				expected,
				kind: "bash",
				category: "c",
				available: true,
				risk: "low",
				rationale: "x",
				latencyMs: 1,
				promptTokens: 1,
				cachedTokens: 0,
				error: null,
			})}\n`;
		writeFileSync(
			join(results, `${runId}.jsonl`),
			line("redcode-exec/12_1", "redcode-exec", "harmful") + line("rogue/1", "rogue-security", "benign"),
		);

		const captured = fakePi();
		const { ctx } = fakeCtx();
		const out = await captureStdout(async () => {
			await captured.commands["judge-bench"].handler(`rescore ${runId}`, ctx);
		});
		expect(out).toContain("rescored");
		expect(out).toContain("relabelled 1 of 2");
		const records = readFileSync(join(results, `${runId}.jsonl`), "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));
		expect(records.find((r) => r.recordId === "redcode-exec/12_1").expected).toBe("benign-for-gate");
		expect(records.find((r) => r.recordId === "rogue/1").expected).toBe("benign"); // non-id-derivable, untouched
	});

	it("dispatches `compare` with no runs to a friendly message", async () => {
		const captured = fakePi();
		const { ctx } = fakeCtx();
		const out = await captureStdout(async () => {
			await captured.commands["judge-bench"].handler("compare", ctx);
		});
		expect(out).toContain("No runs recorded yet");
	});

	it("run with an unmatched model spec reports a resolution error and makes no model call", async () => {
		const captured = fakePi();
		const { ctx, notifications } = fakeCtx([
			{ provider: "anthropic", id: "claude-sonnet-5", reasoning: true },
		]);
		await captured.commands["judge-bench"].handler("run nonexistent-xyz --limit 1", ctx);
		expect(
			notifications.some((n) => n.type === "error" && /no configured model matches/.test(n.message)),
		).toBe(true);
	});

	it("an unknown subcommand prints usage", async () => {
		const captured = fakePi();
		const { ctx, notifications } = fakeCtx();
		await captured.commands["judge-bench"].handler("wat", ctx);
		expect(notifications.some((n) => /usage/.test(n.message))).toBe(true);
	});

	it("without a UI, a notify also reaches stdout so it is not silent under `pi -p`", async () => {
		const captured = fakePi();
		const { ctx } = fakeCtx();
		const out = await captureStdout(async () => {
			await captured.commands["judge-bench"].handler("wat", ctx);
		});
		expect(out).toContain("usage");
	});

	it("cache with a bad --layout reports a usage error before touching a model", async () => {
		const captured = fakePi();
		const { ctx, notifications } = fakeCtx();
		await captured.commands["judge-bench"].handler("cache --layout bogus", ctx);
		expect(notifications.some((n) => n.type === "error" && /unknown --layout/.test(n.message))).toBe(true);
	});

	it("cache with an unmatched model spec reports a resolution error and makes no model call", async () => {
		const captured = fakePi();
		const { ctx, notifications } = fakeCtx([
			{ provider: "anthropic", id: "claude-sonnet-5", reasoning: true },
		]);
		await captured.commands["judge-bench"].handler("cache nonexistent-xyz", ctx);
		expect(
			notifications.some((n) => n.type === "error" && /no configured model matches/.test(n.message)),
		).toBe(true);
	});

	it("cache runs the synthetic session with a fake model and prints the report + writes files", async () => {
		const captured = fakePi();
		const { ctx } = fakeCtxWithModel();
		const out = await captureStdout(async () => {
			await captured.commands["judge-bench"].handler("cache --layout current --calls 2", ctx);
		});
		expect(out).toContain("judge-bench cache");
		expect(out).toContain("current");
		// The report and JSONL were written under PI_GURU_BENCH_DIR/results with the cache- prefix.
		const results = join(dir, "results");
		const files = readdirSync(results);
		expect(files.some((f) => f.startsWith("cache-") && f.endsWith(".md"))).toBe(true);
		expect(files.some((f) => f.startsWith("cache-") && f.endsWith(".jsonl"))).toBe(true);
	});

	it("cache appends a `pi-guru-bench:result` entry with the report table", async () => {
		const captured = fakePi();
		const { ctx } = fakeCtxWithModel();
		await captureStdout(async () => {
			await captured.commands["judge-bench"].handler("cache --layout current --calls 2", ctx);
		});
		const entry = captured.entries.find((e) => e.kind === "pi-guru-bench:result");
		expect(entry).toBeDefined();
		const data = entry?.data as { kind: string; markdown: string; reading: unknown };
		expect(data.kind).toBe("cache");
		expect(data.markdown).toContain("judge-bench cache");
		expect(data.reading).toBeNull(); // cache has no scored rates, so no reading
	});

	it("run appends a result entry; the reading is off when the level is off", async () => {
		setLevel("off");
		const captured = fakePi();
		const { ctx } = fakeCtxWithModel();
		await captureStdout(async () => {
			await captured.commands["judge-bench"].handler("run --sources hand-written --limit 3", ctx);
		});
		const entry = captured.entries.find((e) => e.kind === "pi-guru-bench:result");
		expect(entry).toBeDefined();
		const data = entry?.data as { kind: string; markdown: string; reading: unknown; readingNote: unknown };
		expect(data.kind).toBe("run");
		expect(data.markdown).toContain("judge-bench run");
		expect(data.reading).toBeNull();
		expect(data.readingNote).toBeNull();
	});

	it("run over a tiny source suppresses the reading below the N floor, with a note", async () => {
		setLevel("technical");
		const captured = fakePi();
		const { ctx } = fakeCtxWithModel();
		await captureStdout(async () => {
			await captured.commands["judge-bench"].handler("run --sources hand-written --limit 3", ctx);
		});
		const entry = captured.entries.find((e) => e.kind === "pi-guru-bench:result");
		const data = entry?.data as { reading: unknown; readingNote: string | null };
		expect(data.reading).toBeNull();
		expect(data.readingNote).toMatch(/suppressed/);
	});

	it("run --passes N --layout L records passes and layout, one JSONL line per (record, pass)", async () => {
		setLevel("off");
		const captured = fakePi();
		const { ctx } = fakeCtxWithModel();
		await captureStdout(async () => {
			await captured.commands["judge-bench"].handler(
				"run --sources hand-written --limit 2 --passes 3 --layout prefix-stable",
				ctx,
			);
		});
		const results = join(dir, "results");
		const summaryFile = readdirSync(results).find((f) => f.endsWith(".summary.json"));
		expect(summaryFile).toBeDefined();
		const summary = JSON.parse(readFileSync(join(results, summaryFile as string), "utf8"));
		expect(summary.passes).toBe(3);
		expect(summary.layout).toBe("prefix-stable");
		const jsonlFile = readdirSync(results).find((f) => f.endsWith(".jsonl")) as string;
		const recordLines = readFileSync(join(results, jsonlFile), "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l))
			.filter((l) => l.type === "record");
		expect(recordLines).toHaveLength(6); // 2 records × 3 passes
		expect(new Set(recordLines.map((r) => r.pass))).toEqual(new Set([1, 2, 3]));
	});

	it("run --prompt v2 records the prompt version in the summary and run id", async () => {
		setLevel("off");
		const captured = fakePi();
		const { ctx } = fakeCtxWithModel();
		await captureStdout(async () => {
			await captured.commands["judge-bench"].handler("run --sources hand-written --limit 1 --prompt v2", ctx);
		});
		const results = join(dir, "results");
		const summaryFile = readdirSync(results).find((f) => f.endsWith(".summary.json")) as string;
		const summary = JSON.parse(readFileSync(join(results, summaryFile), "utf8"));
		expect(summary.promptVersion).toBe("v2");
		expect(summary.run).toContain("-v2");
	});

	it("run --prompt with an unknown version reports a usage error before touching a model", async () => {
		const captured = fakePi();
		const { ctx, notifications } = fakeCtxWithModel();
		await captured.commands["judge-bench"].handler("run --sources hand-written --prompt v9", ctx);
		expect(notifications.some((n) => n.type === "error" && /unknown --prompt/.test(n.message))).toBe(true);
	});

	it("resume refuses while the original writer is alive, and makes no model call", async () => {
		// Seed a resumable run (jsonl + summary) plus a `<run>.lock` held by pid 1 — always a live
		// process we lack permission to signal (EPERM → alive), so the refusal path fires without a
		// fake probe. pid 1 ≠ the test process, so it is a *foreign* live holder.
		const runId = "2026-locked-current";
		const results = join(dir, "results");
		mkdirSync(results, { recursive: true });
		writeFileSync(
			join(results, `${runId}.jsonl`),
			`${JSON.stringify({
				type: "record",
				recordId: "s/1",
				pass: 1,
				source: "s",
				sourceVersion: "v",
				expected: "harmful",
				kind: "bash",
				category: "c",
				available: true,
				risk: "high",
				rationale: "x",
				latencyMs: 1,
				promptTokens: 1,
				cachedTokens: 0,
				error: null,
			})}\n`,
		);
		writeFileSync(
			join(results, `${runId}.summary.json`),
			JSON.stringify({
				run: runId,
				model: { provider: "fake", id: "model" },
				layout: "current",
				promptVersion: "v1",
				facts: false,
				seed: "s",
				limit: null,
				passes: 1,
				sources: "all",
				timeoutMs: 60000,
				started: "2026-09-02T00:00:00.000Z",
				finished: null,
				total: 0,
				perSource: [],
				sourceFailed: [],
			}),
		);
		writeFileSync(
			join(results, `${runId}.lock`),
			`${JSON.stringify({ pid: 1, startedAt: "2026-09-02T00:00:00.000Z" })}\n`,
		);

		const captured = fakePi();
		const { ctx, notifications } = fakeCtxWithModel();
		await captured.commands["judge-bench"].handler(`run --resume ${runId}`, ctx);
		expect(
			notifications.some(
				(n) => n.type === "error" && /already being written by a live process/.test(n.message),
			),
		).toBe(true);
		// The lock is left intact for the live holder — the refusing dispatch never took it over.
		const lock = JSON.parse(readFileSync(join(results, `${runId}.lock`), "utf8"));
		expect(lock.pid).toBe(1);
	});

	it("a completed run leaves no `<run>.lock` behind", async () => {
		setLevel("off");
		const captured = fakePi();
		const { ctx } = fakeCtxWithModel();
		await captureStdout(async () => {
			await captured.commands["judge-bench"].handler("run --sources hand-written --limit 2", ctx);
		});
		const results = join(dir, "results");
		expect(readdirSync(results).some((f) => f.endsWith(".lock"))).toBe(false);
	});

	it("run rejects a --passes value that is not 1, 3, or 9", async () => {
		const captured = fakePi();
		const { ctx, notifications } = fakeCtxWithModel();
		await captured.commands["judge-bench"].handler("run --sources hand-written --passes 2", ctx);
		expect(notifications.some((n) => n.type === "error" && /--passes must be one of/.test(n.message))).toBe(
			true,
		);
	});

	it("cache --pad-tokens records the padding and reports it", async () => {
		const captured = fakePi();
		const { ctx } = fakeCtxWithModel();
		const out = await captureStdout(async () => {
			await captured.commands["judge-bench"].handler(
				"cache --layout current --calls 2 --pad-tokens 500",
				ctx,
			);
		});
		expect(out).toContain("pad-tokens: 500");
		const results = join(dir, "results");
		const summaryFile = readdirSync(results).find(
			(f) => f.startsWith("cache-") && f.endsWith(".summary.json"),
		) as string;
		const summary = JSON.parse(readFileSync(join(results, summaryFile), "utf8"));
		expect(summary.padTokens).toBe(500);
	});

	it("compare --read appends a compare result entry", async () => {
		setLevel("technical");
		const captured = fakePi();
		const { ctx } = fakeCtxWithModel();
		await captureStdout(async () => {
			await captured.commands["judge-bench"].handler("run --sources hand-written --limit 3", ctx);
			await captured.commands["judge-bench"].handler("compare --read", ctx);
		});
		const compareEntry = captured.entries.filter((e) => e.kind === "pi-guru-bench:result").at(-1);
		const data = compareEntry?.data as { runId: string; markdown: string };
		expect(data.runId).toBe("compare");
		expect(data.markdown).toContain("judge-bench compare");
	});
});
