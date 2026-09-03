/**
 * the design notes, item 4 — the resumed-segment double-judging, reproduced with a fake completer.
 *
 * The evidence run judged 112 distinct-id (recordId, pass) keys twice, interleaved. A single
 * concurrency-1 runner cannot interleave two records' passes (it is record-major), so two dispatches
 * were writing the same run at once. The decisive detail is a sink/done-key mismatch: a second
 * dispatch loads the JSONL once at construction, then the first dispatch keeps appending — records
 * the second's stale in-memory view never sees, so it re-judges them.
 *
 * This test stages exactly that: a resumed sink loads a mid-record-cut checkpoint, a concurrent
 * dispatch appends more records to the same file, and the resumed runner must NOT re-judge them.
 * Before the fix (`doneKeys()` read only the stale in-memory set) the appended records are judged
 * again; after it (`doneKeys()` reads live from disk, guarded per call) they are skipped.
 */

import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LoadResult } from "../../src/bench/loader.ts";
import { FileRunSink, readRun, readRunRecords } from "../../src/bench/results.ts";
import type { RunMeta, RunRecord } from "../../src/bench/run-result.ts";
import { BenchRunner } from "../../src/bench/runner.ts";
import type { BenchRecord } from "../../src/bench/schema.ts";
import type { AssistantMessage, Completer, Context } from "../../src/model.ts";

let dir: string;
const prev = process.env.PI_GURU_BENCH_DIR;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-guru-bench-dj-"));
	process.env.PI_GURU_BENCH_DIR = dir;
});
afterEach(() => {
	if (prev === undefined) delete process.env.PI_GURU_BENCH_DIR;
	else process.env.PI_GURU_BENCH_DIR = prev;
	rmSync(dir, { recursive: true, force: true });
});

const META: RunMeta = {
	run: "dj-run",
	model: { provider: "fake", id: "m" },
	layout: "current",
	promptVersion: "v1",
	facts: false,
	seed: "seed-1",
	limit: null,
	passes: 3,
	sources: "all",
	timeoutMs: 60000,
	started: "2026-09-02T00:00:00.000Z",
	finished: null,
};

function bench(id: string): BenchRecord {
	return {
		source: "s1",
		sourceVersion: "v1",
		id,
		category: "c",
		kind: "bash",
		expected: "harmful",
		label: "harmful",
		transcriptEntries: [],
		pending: { title: "p", detail: "RISK=low" },
		origin: { url: "", license: "", attribution: "" },
	};
}

function fakeCompleter(counter: { calls: number }) {
	return (_signal: AbortSignal): Completer =>
		async (_context: Context): Promise<AssistantMessage> => {
			counter.calls++;
			return {
				role: "assistant",
				content: [{ type: "text", text: '{"risk":"low","rationale":"ok"}' }],
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			} as unknown as AssistantMessage;
		};
}

/** One committed JSONL line, as a prior/concurrent dispatch would have written it. */
function line(recordId: string, pass: number): string {
	const record: RunRecord = {
		recordId,
		pass,
		source: "s1",
		sourceVersion: "v1",
		expected: "harmful",
		kind: "bash",
		category: "c",
		available: true,
		risk: "low",
		rationale: "from another dispatch",
		latencyMs: 1,
		promptTokens: 1,
		cachedTokens: 0,
		error: null,
	};
	return `${JSON.stringify({ type: "record", ...record })}\n`;
}

function loaderReturning(records: BenchRecord[]) {
	return async (): Promise<LoadResult> => ({ records, events: [] });
}

describe("resumed-segment double-judging (the design notes item 4)", () => {
	it("a resumed dispatch does not re-judge records a concurrent dispatch appended after it loaded", async () => {
		const jsonl = join(dir, "results", "dj-run.jsonl");

		// A prior segment checkpointed record `a` (all 3 passes) and exited mid-record on `c` — the
		// realistic ~30-min-cap state. This is what the resumed dispatch loads.
		const seed = new FileRunSink("dj-run"); // fresh — creates the file
		appendFileSync(jsonl, line("a", 1) + line("a", 2) + line("a", 3));
		void seed;

		// The resumed dispatch loads that checkpoint into memory now…
		const sink = new FileRunSink("dj-run", true);
		expect(sink.allRecords().map((r) => r.recordId)).toEqual(["a", "a", "a"]);

		// …then a CONCURRENT dispatch finishes `b` (all passes) and one pass of `c`, appending to the
		// same file. The resumed sink's in-memory view is now stale relative to disk.
		appendFileSync(jsonl, line("b", 1) + line("b", 2) + line("b", 3) + line("c", 1));

		const counter = { calls: 0 };
		const runner = new BenchRunner({
			meta: { ...META },
			seed: META.seed,
			makeCompleter: fakeCompleter(counter),
			sink,
			loadSourcesFn: loaderReturning([bench("a"), bench("b"), bench("c")]),
		});
		await runner.run();

		// The run must only judge the genuinely-missing passes: c/2 and c/3. Never a, b, or c/1 again.
		expect(counter.calls).toBe(2);

		const { records } = readRun("dj-run");
		const keys = records.map((r) => `${r.recordId}#${r.pass}`);
		const dup = keys.filter((k, i) => keys.indexOf(k) !== i);
		expect(dup).toEqual([]); // no (recordId, pass) judged twice
		// Every record ends with exactly its three passes.
		for (const id of ["a", "b", "c"]) {
			expect(
				records
					.filter((r) => r.recordId === id)
					.map((r) => r.pass)
					.sort(),
			).toEqual([1, 2, 3]);
		}
	});

	it("resume from a byte-truncated JSONL does not crash (tolerant parse)", async () => {
		const jsonl = join(dir, "results", "trunc.jsonl");
		const s = new FileRunSink("trunc"); // creates the file
		appendFileSync(jsonl, line("a", 1) + line("a", 2));
		// A hard kill mid-write leaves a partial final line.
		appendFileSync(jsonl, line("a", 3).slice(0, 30));
		void s;

		// Neither resume nor readRun throws on the partial line; both keep the whole records.
		const resumed = new FileRunSink("trunc", true);
		expect([...resumed.doneKeys()].sort()).toEqual(["a#1", "a#2"]);
		expect(readRunRecords("trunc").records).toHaveLength(2);
	});
});
