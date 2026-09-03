import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	FileRunSink,
	formatCompare,
	formatDiff,
	formatRunReport,
	makeRunId,
	readRun,
	readRunRecords,
	repairRun,
	rescoreRun,
	resolveRunId,
	resultsDir,
	retryUnavailable,
} from "../../src/bench/results.ts";
import { computeSummary, type RunMeta, type RunRecord } from "../../src/bench/run-result.ts";
import type { Expected } from "../../src/bench/schema.ts";
import { redcodeExpectedForId } from "../../src/bench/sources/redcode.ts";

let dir: string;
const prev = process.env.PI_GURU_BENCH_DIR;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-guru-bench-results-"));
	process.env.PI_GURU_BENCH_DIR = dir;
});
afterEach(() => {
	if (prev === undefined) delete process.env.PI_GURU_BENCH_DIR;
	else process.env.PI_GURU_BENCH_DIR = prev;
	rmSync(dir, { recursive: true, force: true });
});

function meta(run: string, over: Partial<RunMeta> = {}): RunMeta {
	return {
		run,
		model: { provider: "anthropic", id: "claude-sonnet-5" },
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
		...over,
	};
}

function rec(over: Partial<RunRecord> & Pick<RunRecord, "recordId" | "source" | "expected">): RunRecord {
	return {
		pass: 1,
		sourceVersion: "v1",
		kind: "bash",
		category: "c",
		available: true,
		risk: "low",
		rationale: "ok",
		latencyMs: 100,
		promptTokens: 10,
		cachedTokens: 0,
		error: null,
		...over,
	};
}

describe("makeRunId", () => {
	it("is filesystem-safe (no slashes or colons)", () => {
		const id = makeRunId(
			{ provider: "anthropic", id: "claude/sonnet:5" },
			"current",
			"v1",
			true,
			new Date("2026-09-02T20:30:00Z"),
		);
		expect(id).not.toMatch(/[/:]/);
		expect(id).toContain("anthropic");
	});
});

describe("FileRunSink checkpoint + resume", () => {
	it("creates the JSONL before the first record and appends per record", () => {
		const sink = new FileRunSink("run-a");
		const path = join(resultsDir(), "run-a.jsonl");
		expect(existsSync(path)).toBe(true); // created before any record
		sink.appendSourceFailed({ source: "local-manifest", reason: "no manifest" });
		sink.appendRecord(rec({ recordId: "s1/1", source: "s1", expected: "harmful", risk: "high" }));
		sink.writeSummary(computeSummary(meta("run-a"), sink.allRecords(), sink.sourceFailures()));

		const lines = readFileSync(path, "utf8").trim().split("\n");
		expect(JSON.parse(lines[0]).type).toBe("source-failed");
		expect(JSON.parse(lines[1]).type).toBe("record");
		expect(existsSync(join(resultsDir(), "run-a.summary.json"))).toBe(true);
		expect(existsSync(join(resultsDir(), "run-a.md"))).toBe(true);
	});

	it("resume loads prior records so doneKeys skips them and the summary stays whole", () => {
		const first = new FileRunSink("run-b");
		first.appendRecord(rec({ recordId: "s1/1", source: "s1", expected: "harmful", risk: "high" }));
		first.appendSourceFailed({ source: "x", reason: "boom" });

		const resumed = new FileRunSink("run-b", true);
		expect(resumed.doneKeys()).toEqual(new Set(["s1/1#1"]));
		expect(resumed.sourceFailures()).toEqual([{ source: "x", reason: "boom" }]);
		// A second failure for the same source is de-duplicated across the resume.
		resumed.appendSourceFailed({ source: "x", reason: "boom again" });
		expect(resumed.sourceFailures()).toHaveLength(1);
		resumed.appendRecord(rec({ recordId: "s1/2", source: "s1", expected: "benign", risk: "low" }));
		expect(resumed.allRecords().map((r) => r.recordId)).toEqual(["s1/1", "s1/2"]);
	});

	it("a fresh (non-resume) sink truncates any prior file", () => {
		const a = new FileRunSink("run-c");
		a.appendRecord(rec({ recordId: "s1/1", source: "s1", expected: "benign" }));
		const b = new FileRunSink("run-c"); // resume=false → start over
		expect(b.doneKeys().size).toBe(0);
	});
});

describe("repairRun", () => {
	it("drops /undefined ids and duplicate (recordId,pass) lines, keeping the first; idempotent", () => {
		const sink = new FileRunSink("run-rep");
		sink.appendSourceFailed({ source: "local-manifest", reason: "no manifest" });
		// two good records, one judged twice (a duplicate line), plus collapsed /undefined ids.
		sink.appendRecord(rec({ recordId: "s1/1", source: "s1", expected: "harmful", risk: "high", pass: 1 }));
		sink.appendRecord(
			rec({ recordId: "s1/1", source: "s1", expected: "harmful", risk: "low", pass: 1, rationale: "dup" }),
		);
		sink.appendRecord(rec({ recordId: "s1/2", source: "s1", expected: "benign", risk: "low", pass: 1 }));
		sink.appendRecord(
			rec({ recordId: "rogue/undefined", source: "rogue", expected: "harmful", risk: "high", pass: 1 }),
		);
		sink.appendRecord(
			rec({ recordId: "rogue/undefined", source: "rogue", expected: "benign", risk: "low", pass: 2 }),
		);
		sink.writeSummary(computeSummary(meta("run-rep"), sink.allRecords(), sink.sourceFailures()));

		const result = repairRun("run-rep");
		expect(result.removedDuplicates).toBe(1); // the second s1/1#1
		expect(result.removedUndefined).toBe(2); // both rogue/undefined rows
		expect(result.kept).toBe(2); // s1/1, s1/2

		const { records, failures } = readRunRecords("run-rep");
		expect(records.map((r) => r.recordId).sort()).toEqual(["s1/1", "s1/2"]);
		// the kept s1/1 is the FIRST line (risk high), not the duplicate.
		expect(records.find((r) => r.recordId === "s1/1")?.risk).toBe("high");
		expect(failures).toEqual([{ source: "local-manifest", reason: "no manifest" }]); // preserved
		// summary + md rewritten from the survivors.
		expect(existsSync(join(resultsDir(), "run-rep.summary.json"))).toBe(true);
		const rewritten = readRun("run-rep");
		expect(rewritten.summary.total).toBe(2);

		// Idempotent: a second repair removes nothing and leaves the file byte-identical.
		const before = readFileSync(join(resultsDir(), "run-rep.jsonl"), "utf8");
		const again = repairRun("run-rep");
		expect(again.removedDuplicates).toBe(0);
		expect(again.removedUndefined).toBe(0);
		expect(readFileSync(join(resultsDir(), "run-rep.jsonl"), "utf8")).toBe(before);
	});

	it("throws on an unknown run reference", () => {
		expect(() => repairRun("nope")).toThrow(/no run matches/);
	});
});

describe("retryUnavailable", () => {
	it("drops unavailable lines, keeps one .bak, rewrites the summary, and reports the count", () => {
		const sink = new FileRunSink("run-ru");
		sink.appendSourceFailed({ source: "local-manifest", reason: "no manifest" });
		sink.appendRecord(rec({ recordId: "s1/1", source: "s1", expected: "harmful", risk: "high" }));
		sink.appendRecord(
			rec({
				recordId: "s1/2",
				source: "s1",
				expected: "harmful",
				available: false,
				risk: null,
				rationale: null,
				error: "unparseable verdict",
				reason: "unparseable verdict",
				raw: "I cannot rate this.",
			}),
		);
		sink.appendRecord(rec({ recordId: "s1/3", source: "s1", expected: "benign", risk: "low" }));
		sink.writeSummary(computeSummary(meta("run-ru"), sink.allRecords(), sink.sourceFailures()));

		const result = retryUnavailable("run-ru");
		expect(result.retried).toBe(1);
		expect(result.kept).toBe(2);

		// A .bak preserves the original (with the unavailable line still in it).
		const bak = join(resultsDir(), "run-ru.jsonl.bak");
		expect(existsSync(bak)).toBe(true);
		expect(readFileSync(bak, "utf8")).toContain("I cannot rate this.");

		// The rewritten JSONL has only the available records; the source-failed line is preserved.
		const { records, failures } = readRunRecords("run-ru");
		expect(records.map((r) => r.recordId).sort()).toEqual(["s1/1", "s1/3"]);
		expect(failures).toEqual([{ source: "local-manifest", reason: "no manifest" }]);
		expect(readRun("run-ru").summary.total).toBe(2);
	});

	it("is a no-op with retried=0 when nothing is unavailable, and never clobbers an existing .bak", () => {
		const sink = new FileRunSink("run-ru2");
		sink.appendRecord(rec({ recordId: "s1/1", source: "s1", expected: "harmful", risk: "high" }));
		sink.appendRecord(
			rec({
				recordId: "s1/2",
				source: "s1",
				expected: "benign",
				available: false,
				risk: null,
				rationale: null,
			}),
		);
		sink.writeSummary(computeSummary(meta("run-ru2"), sink.allRecords(), sink.sourceFailures()));

		const first = retryUnavailable("run-ru2");
		expect(first.retried).toBe(1);
		const bak = join(resultsDir(), "run-ru2.jsonl.bak");
		const bakContent = readFileSync(bak, "utf8");

		// A second retry finds nothing to drop and leaves the first backup untouched.
		const again = retryUnavailable("run-ru2");
		expect(again.retried).toBe(0);
		expect(readFileSync(bak, "utf8")).toBe(bakContent);
	});

	it("throws on an unknown run reference", () => {
		expect(() => retryUnavailable("nope")).toThrow(/no run matches/);
	});
});

describe("formatRunReport unavailable raw section", () => {
	it("lists each unavailable record with its reason and raw reply", () => {
		const records: RunRecord[] = [
			rec({ recordId: "s1/1", source: "s1", expected: "harmful", risk: "high" }),
			rec({
				recordId: "s1/2",
				source: "s1",
				expected: "harmful",
				available: false,
				risk: null,
				rationale: null,
				error: "unparseable verdict",
				reason: "unparseable verdict",
				raw: "prose before the JSON",
			}),
		];
		const report = formatRunReport(computeSummary(meta("run-raw"), records, []), records);
		expect(report).toContain("unavailable records (raw model reply)");
		expect(report).toContain("`s1/2` pass 1");
		expect(report).toContain("reason: unparseable verdict");
		expect(report).toContain("prose before the JSON");
	});
});

describe("rescoreRun", () => {
	// The extension's resolver: redcode's expected is id-derivable; every other source keeps its label.
	const resolve = (r: RunRecord): Expected =>
		r.source === "redcode-exec" ? redcodeExpectedForId(r.recordId) : r.expected;

	it("re-labels code-weakness records benign-for-gate, rewrites summary + report, idempotently", () => {
		const sink = new FileRunSink("run-rs");
		sink.appendSourceFailed({ source: "local-manifest", reason: "no manifest" });
		// A pre-split JSONL: every redcode record stored `harmful`.
		sink.appendRecord(
			rec({ recordId: "redcode-exec/1_1", source: "redcode-exec", expected: "harmful", risk: "high" }),
		);
		sink.appendRecord(
			rec({ recordId: "redcode-exec/12_1", source: "redcode-exec", expected: "harmful", risk: "low" }),
		);
		sink.appendRecord(
			rec({ recordId: "redcode-exec/12_2", source: "redcode-exec", expected: "harmful", risk: "high" }),
		);
		// A different source's label is not id-derivable and must be left alone.
		sink.appendRecord(
			rec({ recordId: "rogue/1", source: "rogue-security", expected: "benign", risk: "low" }),
		);
		sink.writeSummary(computeSummary(meta("run-rs"), sink.allRecords(), sink.sourceFailures()));

		const result = rescoreRun("run-rs", resolve);
		expect(result.changed).toBe(2); // both scenario-12 records move harmful → benign-for-gate
		expect(result.total).toBe(4);

		const { records, failures } = readRunRecords("run-rs");
		const expectedOf = (id: string) => records.find((r) => r.recordId === id)?.expected;
		expect(expectedOf("redcode-exec/1_1")).toBe("harmful"); // environment-harm scenario unchanged
		expect(expectedOf("redcode-exec/12_1")).toBe("benign-for-gate");
		expect(expectedOf("redcode-exec/12_2")).toBe("benign-for-gate");
		expect(expectedOf("rogue/1")).toBe("benign"); // non-id-derivable source untouched
		expect(failures).toEqual([{ source: "local-manifest", reason: "no manifest" }]); // preserved

		// The rewritten summary buckets the two scenario-12 records apart from harmful/benign.
		const redcode = readRun("run-rs").summary.perSource.find((s) => s.source === "redcode-exec");
		expect(redcode?.benignForGateN).toBe(2);
		expect(redcode?.benignForGateBlocked).toBe(0.5); // one of the two rated high
		expect(redcode?.harmfulN).toBe(1); // only 1_1 stays harmful
		// The report shows the benign-for-gate row.
		expect(readFileSync(join(resultsDir(), "run-rs.md"), "utf8")).toContain("benign-for-gate blocked");

		// Idempotent: a second rescore with the same converters moves nothing.
		expect(rescoreRun("run-rs", resolve).changed).toBe(0);
	});

	it("throws on an unknown run reference", () => {
		expect(() => rescoreRun("nope", resolve)).toThrow(/no run matches/);
	});
});

describe("benign-for-gate scoring + report", () => {
	it("scores benign-for-gate in its own bucket, out of harmful/benign, with a report row", () => {
		const records: RunRecord[] = [
			rec({ recordId: "r/h", source: "redcode-exec", expected: "harmful", risk: "high" }),
			rec({ recordId: "r/b", source: "redcode-exec", expected: "benign", risk: "low" }),
			rec({ recordId: "r/g1", source: "redcode-exec", expected: "benign-for-gate", risk: "high" }),
			rec({ recordId: "r/g2", source: "redcode-exec", expected: "benign-for-gate", risk: "low" }),
		];
		const summary = computeSummary(meta("run-bfg"), records, []);
		const s = summary.perSource[0];
		expect(s.harmfulN).toBe(1); // benign-for-gate not counted as harmful
		expect(s.benignN).toBe(1); // nor as benign
		expect(s.benignForGateN).toBe(2);
		expect(s.benignForGateBlocked).toBe(0.5); // one of two rated high
		expect(s.majorityBenignForGateN).toBe(2);
		expect(s.majorityBenignForGateBlocked).toBe(0.5);

		const report = formatRunReport(summary, records);
		expect(report).toContain("benign-for-gate blocked  (P risk=high");
		expect(report).toContain("n=2 benign-for-gate obs");
		expect(formatCompare([summary])).toContain("benign-for-gate blocked (pool/maj)");
	});

	it("omits the benign-for-gate row for a source with no such records", () => {
		const records: RunRecord[] = [rec({ recordId: "r/h", source: "s1", expected: "harmful", risk: "high" })];
		const report = formatRunReport(computeSummary(meta("run-none"), records, []), records);
		expect(report).not.toContain("benign-for-gate blocked");
	});
});

describe("readRun + resolveRunId", () => {
	it("round-trips a written run and resolves a unique substring", () => {
		const sink = new FileRunSink("2026-run-xyz");
		sink.appendRecord(rec({ recordId: "s1/1", source: "s1", expected: "harmful", risk: "high" }));
		sink.writeSummary(computeSummary(meta("2026-run-xyz"), sink.allRecords(), []));

		expect(resolveRunId("xyz")).toBe("2026-run-xyz");
		const run = readRun("xyz");
		expect(run.records).toHaveLength(1);
		expect(run.summary.perSource[0].source).toBe("s1");
	});

	it("throws on an unknown run reference", () => {
		expect(() => resolveRunId("nope")).toThrow(/no run matches/);
	});
});

describe("compare + diff formatting", () => {
	it("compare has one row per (run, source) and no pooled headline", () => {
		const s1 = new FileRunSink("run-1");
		s1.appendRecord(rec({ recordId: "a/1", source: "s1", expected: "harmful", risk: "high" }));
		s1.appendRecord(rec({ recordId: "b/1", source: "s2", expected: "benign", risk: "low" }));
		const summary = computeSummary(meta("run-1"), s1.allRecords(), []);
		const out = formatCompare([summary]);
		expect(out).toContain("no pooled headline");
		expect(out).toContain("s1");
		expect(out).toContain("s2");
		// two source rows for the one run
		expect(out.split("\n").filter((l) => l.includes("run-1")).length).toBe(2);
	});

	it("diff lists only the records whose verdicts disagree", () => {
		const a = new FileRunSink("run-A");
		a.appendRecord(rec({ recordId: "x/1", source: "s1", expected: "harmful", risk: "low" }));
		a.appendRecord(rec({ recordId: "x/2", source: "s1", expected: "harmful", risk: "high" }));
		a.writeSummary(computeSummary(meta("run-A"), a.allRecords(), []));

		const b = new FileRunSink("run-B");
		b.appendRecord(rec({ recordId: "x/1", source: "s1", expected: "harmful", risk: "high" })); // differs
		b.appendRecord(rec({ recordId: "x/2", source: "s1", expected: "harmful", risk: "high" })); // same
		b.writeSummary(computeSummary(meta("run-B"), b.allRecords(), []));

		const out = formatDiff(readRun("run-A"), readRun("run-B"));
		expect(out).toContain("x/1");
		expect(out).not.toContain("| x/2 |");
		expect(out).toContain("1 of the shared records disagree");
	});
});
