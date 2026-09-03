import { describe, expect, it } from "vitest";
import { SYNTHETIC_AGENT_SYSTEM_PROMPT } from "../../src/bench/cache-session.ts";
import { toEntries } from "../../src/bench/entries.ts";
import type { LoadResult } from "../../src/bench/loader.ts";
import type { RunMeta, RunRecord, RunSummary } from "../../src/bench/run-result.ts";
import { BenchRunner, type RunSink } from "../../src/bench/runner.ts";
import type { BenchRecord, SourceEvent } from "../../src/bench/schema.ts";
import type { AssistantMessage, Completer, Context } from "../../src/model.ts";

const USAGE = {
	input: 42,
	output: 8,
	cacheRead: 5,
	cacheWrite: 0,
	totalTokens: 50,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const META: RunMeta = {
	run: "test-run",
	model: { provider: "fake", id: "model" },
	layout: "current",
	promptVersion: "v1",
	facts: false,
	seed: "seed-1",
	limit: null,
	passes: 1,
	sources: "all",
	timeoutMs: 60000,
	started: "2026-09-02T00:00:00.000Z",
	finished: null,
};

/** A benchmark record whose intended verdict is encoded in `pending.detail` as `RISK=<x>`. */
function bench(id: string, expected: "harmful" | "benign", risk: string): BenchRecord {
	return {
		source: "s1",
		sourceVersion: "v1",
		id,
		category: "c",
		kind: "bash",
		expected,
		label: expected,
		transcriptEntries: [],
		pending: { title: "pending action", detail: `RISK=${risk}` },
		origin: { url: "", license: "", attribution: "" },
	};
}

function textOf(context: Context): string {
	const parts: string[] = [];
	for (const m of context.messages) {
		if (typeof m.content === "string") parts.push(m.content);
		else if (Array.isArray(m.content))
			for (const c of m.content) parts.push((c as { text?: string }).text ?? "");
	}
	return parts.join("\n");
}

/** A fake model: reads `RISK=<x>` from the message and replies accordingly. Counts its calls. */
function fakeCompleter(counter: { calls: number }) {
	return (signal: AbortSignal): Completer =>
		async (context: Context): Promise<AssistantMessage> => {
			counter.calls++;
			const text = textOf(context);
			if (text.includes("RISK=hang")) {
				return new Promise<AssistantMessage>((_resolve, reject) => {
					if (signal.aborted) return reject(new Error("aborted"));
					signal.addEventListener("abort", () => reject(new Error("aborted")));
				});
			}
			const reply = text.includes("RISK=unparseable")
				? "I cannot rate this."
				: `{"risk":"${text.match(/RISK=(low|medium|high)/)?.[1] ?? "low"}","rationale":"ok"}`;
			return {
				role: "assistant",
				content: [{ type: "text", text: reply }],
				usage: USAGE,
				timestamp: Date.now(),
			} as unknown as AssistantMessage;
		};
}

/** An in-memory sink so the runner is exercised without touching disk. */
class MemSink implements RunSink {
	records: RunRecord[] = [];
	failures: { source: string; reason: string }[] = [];
	summaries: RunSummary[] = [];
	appendSourceFailed(line: { source: string; reason: string }): void {
		this.failures.push({ source: line.source, reason: line.reason });
	}
	appendRecord(record: RunRecord): void {
		this.records.push(record);
	}
	writeSummary(summary: RunSummary): void {
		this.summaries.push(summary);
	}
	allRecords(): RunRecord[] {
		return this.records;
	}
	sourceFailures(): { source: string; reason: string }[] {
		return this.failures;
	}
	doneKeys(): Set<string> {
		return new Set(this.records.map((r) => `${r.recordId}#${r.pass}`));
	}
}

function loaderReturning(records: BenchRecord[], events: SourceEvent[] = []) {
	return async (): Promise<LoadResult> => ({ records, events });
}

describe("BenchRunner", () => {
	it("judges every sampled record through the production path and checkpoints each", async () => {
		const sink = new MemSink();
		const counter = { calls: 0 };
		const runner = new BenchRunner({
			meta: { ...META },
			seed: META.seed,
			makeCompleter: fakeCompleter(counter),
			sink,
			loadSourcesFn: loaderReturning([
				bench("s1/1", "harmful", "high"),
				bench("s1/2", "harmful", "low"),
				bench("s1/3", "benign", "low"),
			]),
		});
		const summary = await runner.run();

		expect(sink.records).toHaveLength(3);
		expect(counter.calls).toBe(3);
		expect(summary.finished).not.toBeNull();
		// A summary was rewritten at least once per record (plus the initial + final writes).
		expect(sink.summaries.length).toBeGreaterThanOrEqual(3);
		const rec = sink.records.find((r) => r.recordId === "s1/1");
		expect(rec?.risk).toBe("high");
		expect(rec?.promptTokens).toBe(42);
		expect(rec?.cachedTokens).toBe(5);
		expect(rec?.latencyMs).toBeGreaterThanOrEqual(0);
		expect(summary.perSource[0].letThroughMedium).toBeCloseTo(1 / 2);
	});

	it("threads the prompt version through to the judge system prompt", async () => {
		const capture = { systemPrompts: [] as string[] };
		const capturingCompleter =
			(_signal: AbortSignal): Completer =>
			async (context: Context): Promise<AssistantMessage> => {
				capture.systemPrompts.push(context.systemPrompt ?? "");
				return {
					role: "assistant",
					content: [{ type: "text", text: '{"risk":"low","rationale":"ok"}' }],
					usage: USAGE,
					timestamp: Date.now(),
				} as unknown as AssistantMessage;
			};
		const runner = new BenchRunner({
			meta: { ...META },
			seed: META.seed,
			promptVersion: "v2",
			makeCompleter: capturingCompleter,
			sink: new MemSink(),
			loadSourcesFn: loaderReturning([bench("s1/1", "harmful", "low")]),
		});
		await runner.run();
		expect(capture.systemPrompts).toHaveLength(1);
		// v2's floor language is present; v1's rubric line is not.
		expect(capture.systemPrompts[0]).toContain("Rate at least medium");
		expect(capture.systemPrompts[0]).not.toContain("routine (reading-adjacent writes, local edits)");
	});

	it("records an unavailable outcome when the reply cannot be parsed", async () => {
		const sink = new MemSink();
		const runner = new BenchRunner({
			meta: { ...META },
			seed: META.seed,
			makeCompleter: fakeCompleter({ calls: 0 }),
			sink,
			loadSourcesFn: loaderReturning([bench("s1/1", "harmful", "unparseable")]),
		});
		await runner.run();
		const rec = sink.records[0];
		expect(rec.available).toBe(false);
		expect(rec.risk).toBeNull();
		expect(rec.error).toMatch(/unparseable/);
		// The raw model reply and the un-normalised reason are kept for diagnosis.
		expect(rec.reason).toBe("unparseable verdict");
		expect(rec.raw).toBe("I cannot rate this.");
		expect(sink.summaries.at(-1)?.perSource[0].unavailableRate).toBe(1);
	});

	it("caps the stored raw reply at 2000 chars", async () => {
		const sink = new MemSink();
		const long = "x".repeat(5000);
		const completer =
			(_signal: AbortSignal): Completer =>
			async (): Promise<AssistantMessage> =>
				({
					role: "assistant",
					content: [{ type: "text", text: long }],
					usage: USAGE,
					timestamp: Date.now(),
				}) as unknown as AssistantMessage;
		const runner = new BenchRunner({
			meta: { ...META },
			seed: META.seed,
			makeCompleter: completer,
			sink,
			loadSourcesFn: loaderReturning([bench("s1/1", "harmful", "low")]),
		});
		await runner.run();
		expect(sink.records[0].available).toBe(false);
		expect(sink.records[0].raw).toHaveLength(2000);
	});

	it("records a timeout at the deadline even when the transport ignores the abort signal", async () => {
		const sink = new MemSink();
		// A completer that never resolves AND never listens to the signal — a transport that ignores
		// the abort. Without the runner's own race the run would hang past the per-call timeout forever.
		const neverResolves =
			(_signal: AbortSignal): Completer =>
			() =>
				new Promise<AssistantMessage>(() => {});
		const runner = new BenchRunner({
			meta: { ...META },
			seed: META.seed,
			perCallTimeoutMs: 30,
			makeCompleter: neverResolves,
			sink,
			loadSourcesFn: loaderReturning([bench("s1/1", "harmful", "low")]),
		});
		const summary = await runner.run();

		// The run did not hang past the deadline: the stuck record is persisted as an unavailable timeout.
		expect(sink.records).toHaveLength(1);
		const stuck = sink.records[0];
		expect(stuck.available).toBe(false);
		expect(stuck.error).toBe("timeout");
		expect(summary.perSource[0].unavailableTimeout).toBe(1);
	});

	it("records a source-failed line and still runs the rest", async () => {
		const sink = new MemSink();
		const runner = new BenchRunner({
			meta: { ...META },
			seed: META.seed,
			makeCompleter: fakeCompleter({ calls: 0 }),
			sink,
			loadSourcesFn: loaderReturning(
				[bench("s1/1", "benign", "low")],
				[{ type: "source-failed", source: "local-manifest", reason: "no manifest" }],
			),
		});
		const summary = await runner.run();
		expect(summary.sourceFailed).toEqual([{ source: "local-manifest", reason: "no manifest" }]);
		expect(sink.records).toHaveLength(1);
	});

	it("resumes: skips records already in the sink and never re-judges them", async () => {
		const sink = new MemSink();
		const records = [
			bench("s1/1", "harmful", "high"),
			bench("s1/2", "harmful", "low"),
			bench("s1/3", "benign", "low"),
		];
		// Pre-seed one record as if a prior run had checkpointed it.
		sink.records.push({
			recordId: "s1/2",
			pass: 1,
			source: "s1",
			sourceVersion: "v1",
			expected: "harmful",
			kind: "bash",
			category: "c",
			available: true,
			risk: "medium",
			rationale: "from prior run",
			latencyMs: 1,
			promptTokens: 1,
			cachedTokens: 0,
			error: null,
		});
		const counter = { calls: 0 };
		const runner = new BenchRunner({
			meta: { ...META },
			seed: META.seed,
			makeCompleter: fakeCompleter(counter),
			sink,
			loadSourcesFn: loaderReturning(records),
		});
		await runner.run();

		expect(counter.calls).toBe(2); // only s1/1 and s1/3, not the pre-seeded s1/2
		expect(sink.records.map((r) => r.recordId).sort()).toEqual(["s1/1", "s1/2", "s1/3"]);
		expect(sink.records.find((r) => r.recordId === "s1/2")?.rationale).toBe("from prior run");
	});

	it("cancellation mid-run stops after the current record and does not finish", async () => {
		const sink = new MemSink();
		const records = Array.from({ length: 6 }, (_, i) => bench(`s1/${i}`, "benign", "low"));
		const runner = new BenchRunner({
			meta: { ...META },
			seed: META.seed,
			makeCompleter: fakeCompleter({ calls: 0 }),
			sink,
			loadSourcesFn: loaderReturning(records),
			onProgress: () => runner.abort(), // abort as soon as the first record commits
		});
		const summary = await runner.run();

		expect(sink.records).toHaveLength(1); // only the first was persisted
		expect(summary.finished).toBeNull(); // aborted runs are not stamped finished
		expect(runner.signal.aborted).toBe(true);
	});

	it("discards an in-flight record when aborted before it is persisted", async () => {
		const sink = new MemSink();
		const runner = new BenchRunner({
			meta: { ...META },
			seed: META.seed,
			makeCompleter: fakeCompleter({ calls: 0 }),
			sink,
			loadSourcesFn: loaderReturning([bench("s1/1", "harmful", "hang")]),
		});
		const done = runner.run();
		await new Promise((r) => setTimeout(r, 10));
		runner.abort();
		const summary = await done;

		expect(sink.records).toHaveLength(0); // the aborted call is not persisted → resume re-runs it
		expect(summary.finished).toBeNull();
	});

	it("records a call that outlives the per-call timeout as unavailable with reason `timeout`", async () => {
		const sink = new MemSink();
		const runner = new BenchRunner({
			meta: { ...META },
			seed: META.seed,
			// A short per-call timeout; the `hang` completer never resolves, so the timeout fires.
			perCallTimeoutMs: 30,
			makeCompleter: fakeCompleter({ calls: 0 }),
			sink,
			loadSourcesFn: loaderReturning([bench("s1/1", "harmful", "hang"), bench("s1/2", "benign", "low")]),
		});
		const summary = await runner.run();

		// The run kept going after the timeout — both records are persisted.
		expect(sink.records).toHaveLength(2);
		const hung = sink.records.find((r) => r.recordId === "s1/1");
		expect(hung?.available).toBe(false);
		expect(hung?.error).toBe("timeout"); // normalised by signal, not by the thrown message
		// The report separates timeouts from other unavailable reasons.
		const s1 = summary.perSource.find((s) => s.source === "s1");
		expect(s1?.unavailableTimeout).toBe(1);
		expect(s1?.unavailableOther).toBe(0);
		expect(summary.timeoutMs).toBe(60000); // the timeout is recorded in the summary
	});
});

describe("BenchRunner — passes", () => {
	/** A record whose transcript carries one user turn, so shared-prefix has messages to pass through. */
	function benchWithTranscript(id: string): BenchRecord {
		return {
			...bench(id, "harmful", "low"),
			transcriptEntries: toEntries([
				{ role: "user", text: "please help" },
			]) as BenchRecord["transcriptEntries"],
		};
	}

	/** Serialize a context to one string: the system prompt plus every message's text. */
	function contextText(context: Context): string {
		const parts = [context.systemPrompt ?? ""];
		for (const m of context.messages) {
			if (typeof m.content === "string") parts.push(m.content);
			else if (Array.isArray(m.content))
				for (const c of m.content) parts.push((c as { text?: string }).text ?? "");
		}
		return parts.join("\n");
	}

	it("judges each record's passes consecutively (record-major) and in pass order", async () => {
		const sink = new MemSink();
		const order: string[] = [];
		const runner = new BenchRunner({
			meta: { ...META, passes: 3 },
			seed: META.seed,
			makeCompleter: fakeCompleter({ calls: 0 }),
			sink,
			loadSourcesFn: loaderReturning([bench("s1/a", "harmful", "low"), bench("s1/b", "benign", "low")]),
			onProgress: (p) => order.push(`${p.lastRecord.recordId}#${p.lastRecord.pass}`),
		});
		await runner.run();

		expect(sink.records).toHaveLength(6); // 2 records × 3 passes
		// Each record forms one contiguous block of passes 1,2,3; a record is never returned to.
		const seen = new Set<string>();
		let current: string | null = null;
		let expectedPass = 0;
		for (const key of order) {
			const [id, p] = key.split("#");
			if (id !== current) {
				expect(seen.has(id)).toBe(false);
				seen.add(id);
				current = id;
				expectedPass = 1;
			}
			expect(Number(p)).toBe(expectedPass);
			expectedPass++;
		}
		expect(seen.size).toBe(2);
	});

	it("resume keys on (recordId, pass): only the missing passes are judged", async () => {
		const sink = new MemSink();
		// Pre-seed pass 1 and pass 3 of one record as already done; pass 2 must still run.
		for (const p of [1, 3]) {
			sink.records.push({
				recordId: "s1/a",
				pass: p,
				source: "s1",
				sourceVersion: "v1",
				expected: "harmful",
				kind: "bash",
				category: "c",
				available: true,
				risk: "low",
				rationale: "prior",
				latencyMs: 1,
				promptTokens: 1,
				cachedTokens: 0,
				error: null,
			});
		}
		const counter = { calls: 0 };
		const runner = new BenchRunner({
			meta: { ...META, passes: 3 },
			seed: META.seed,
			makeCompleter: fakeCompleter(counter),
			sink,
			loadSourcesFn: loaderReturning([bench("s1/a", "harmful", "low")]),
		});
		await runner.run();

		expect(counter.calls).toBe(1); // only the missing pass 2
		const judged = sink.records
			.filter((r) => r.recordId === "s1/a")
			.map((r) => r.pass)
			.sort();
		expect(judged).toEqual([1, 2, 3]);
		// The pre-seeded passes are untouched (their rationale survives).
		expect(sink.records.filter((r) => r.rationale === "prior")).toHaveLength(2);
	});

	it("threads --layout shared-prefix: the agent system prompt replaces the judge prompt", async () => {
		const sink = new MemSink();
		const seen: string[] = [];
		const capture =
			(_signal: AbortSignal): Completer =>
			async (context: Context): Promise<AssistantMessage> => {
				seen.push(contextText(context));
				return {
					role: "assistant",
					content: [{ type: "text", text: '{"risk":"low","rationale":"ok"}' }],
					usage: USAGE,
					timestamp: Date.now(),
				} as unknown as AssistantMessage;
			};
		const runner = new BenchRunner({
			meta: { ...META, passes: 1, layout: "shared-prefix" },
			seed: META.seed,
			layout: "shared-prefix",
			sessionNonce: "runbench",
			makeCompleter: capture,
			sink,
			loadSourcesFn: loaderReturning([benchWithTranscript("s1/a")]),
		});
		await runner.run();
		expect(seen).toHaveLength(1);
		// shared-prefix rides the synthetic agent system prompt and passes the record's own transcript.
		expect(seen[0]).toContain(SYNTHETIC_AGENT_SYSTEM_PROMPT);
		expect(seen[0]).toContain("please help");
	});

	it("threads --layout prefix-stable: the transcript fence uses the run session nonce", async () => {
		const sink = new MemSink();
		const seen: string[] = [];
		const capture =
			(_signal: AbortSignal): Completer =>
			async (context: Context): Promise<AssistantMessage> => {
				seen.push(contextText(context));
				return {
					role: "assistant",
					content: [{ type: "text", text: '{"risk":"low","rationale":"ok"}' }],
					usage: USAGE,
					timestamp: Date.now(),
				} as unknown as AssistantMessage;
			};
		const runner = new BenchRunner({
			meta: { ...META, passes: 1, layout: "prefix-stable" },
			seed: META.seed,
			layout: "prefix-stable",
			sessionNonce: "nonceZ",
			makeCompleter: capture,
			sink,
			loadSourcesFn: loaderReturning([benchWithTranscript("s1/a")]),
		});
		await runner.run();
		expect(seen).toHaveLength(1);
		expect(seen[0]).toContain("UNTRUSTED-nonceZ"); // the per-session fence carries the run nonce
	});
});
