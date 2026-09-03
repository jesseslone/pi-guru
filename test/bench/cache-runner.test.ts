import { describe, expect, it } from "vitest";
import {
	type CacheMeta,
	type CacheRecord,
	CacheRunner,
	type CacheSink,
	type CacheSummary,
	computeCacheSummary,
} from "../../src/bench/cache-runner.ts";
import { buildSyntheticSession } from "../../src/bench/cache-session.ts";
import type { BenchRecord } from "../../src/bench/schema.ts";
import type { JudgeLayout } from "../../src/judge.ts";
import type { AssistantMessage, Completer, Context } from "../../src/model.ts";

/** A bench record whose verdict is encoded in `pending.detail` as `RISK=<x>`. */
function rec(id: string, risk: string): BenchRecord {
	return {
		source: "hand-written",
		sourceVersion: "v",
		id,
		category: "c",
		kind: "bash",
		expected: "harmful",
		authoredRisk: "high",
		label: "high",
		transcriptEntries: [],
		pending: { title: "Run this command?", detail: `RISK=${risk}` },
		origin: { url: "", license: "", attribution: "" },
	};
}

const RECORDS = [rec("a", "low"), rec("b", "medium"), rec("c", "high")];

/** Serialize a context to one string (system prompt + every message's text). */
function serialize(context: Context): string {
	const parts = [context.systemPrompt ?? ""];
	for (const m of context.messages) {
		if (typeof m.content === "string") parts.push(m.content);
		else if (Array.isArray(m.content))
			for (const c of m.content) parts.push((c as { text?: string }).text ?? "");
	}
	return parts.join("\n");
}

function commonPrefixLen(a: string, b: string): number {
	let i = 0;
	while (i < a.length && i < b.length && a[i] === b[i]) i++;
	return i;
}

/**
 * A fake model that mimics vLLM strict-prefix caching: it remembers every prompt it has served and
 * reports `cacheRead` as the longest common prefix (chars, as a token proxy) with any prior prompt.
 * So a layout whose prefix is stable and growing gets a large cached count; a layout that puts fresh
 * bytes near the front gets little beyond the shared system prompt.
 */
function cachingCompleter(seen: string[], counter: { calls: number }) {
	return (_signal: AbortSignal): Completer =>
		async (context: Context): Promise<AssistantMessage> => {
			counter.calls++;
			const prompt = serialize(context);
			let cacheRead = 0;
			for (const prior of seen) cacheRead = Math.max(cacheRead, commonPrefixLen(prompt, prior));
			seen.push(prompt);
			// Read the verdict from the pending-action fence, not the transcript — every layout fences
			// the pending action under "[pending action]", but its position (before/after the transcript)
			// varies, so keying off the pending block keeps the verdict layout-independent.
			const pendingBlock = prompt.slice(prompt.lastIndexOf("[pending action]"));
			const risk = pendingBlock.match(/RISK=(low|medium|high)/)?.[1] ?? "low";
			return {
				role: "assistant",
				content: [{ type: "text", text: `{"risk":"${risk}","rationale":"ok"}` }],
				usage: {
					input: prompt.length,
					output: 4,
					cacheRead,
					cacheWrite: 0,
					totalTokens: prompt.length + 4,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			} as unknown as AssistantMessage;
		};
}

/** An in-memory cache sink. */
class MemoryCacheSink implements CacheSink {
	records: CacheRecord[] = [];
	summaries: CacheSummary[] = [];
	appendRecord(record: CacheRecord): void {
		this.records.push(record);
	}
	writeSummary(summary: CacheSummary): void {
		this.summaries.push(summary);
	}
	allRecords(): CacheRecord[] {
		return this.records;
	}
}

function meta(layouts: JudgeLayout[], calls: number): CacheMeta {
	return {
		run: "cache-test",
		model: { provider: "fake", id: "model" },
		layouts,
		passes: 2,
		calls,
		facts: false,
		timeoutMs: 60000,
		started: "2026-09-03T00:00:00.000Z",
		finished: null,
	};
}

describe("CacheRunner", () => {
	it("judges every layout × pass × call and checkpoints each record", async () => {
		const layouts: JudgeLayout[] = ["current", "prefix-stable", "shared-prefix"];
		const session = buildSyntheticSession(RECORDS, 3);
		const sink = new MemoryCacheSink();
		const counter = { calls: 0 };
		const runner = new CacheRunner({
			meta: meta(layouts, session.steps.length),
			layouts,
			passes: 2,
			session,
			sessionNonce: "nonceX",
			makeCompleter: cachingCompleter([], counter),
			sink,
		});
		const summary = await runner.run();
		// 3 layouts × 2 passes × 3 calls = 18.
		expect(counter.calls).toBe(18);
		expect(sink.records).toHaveLength(18);
		expect(summary.finished).not.toBeNull();
		// A summary was rewritten after each record plus the final finish.
		expect(sink.summaries.length).toBeGreaterThanOrEqual(18);
		expect(summary.perLayout.map((l) => l.layout)).toEqual(layouts);
	});

	it("shows more cache reuse for prefix-stable than for current (repeat pass)", async () => {
		const layouts: JudgeLayout[] = ["current", "prefix-stable"];
		const session = buildSyntheticSession(RECORDS, 3);
		const sink = new MemoryCacheSink();
		const runner = new CacheRunner({
			meta: meta(layouts, session.steps.length),
			layouts,
			passes: 2,
			session,
			sessionNonce: "nonceX",
			makeCompleter: cachingCompleter([], { calls: 0 }),
			sink,
		});
		const summary = await runner.run();
		const current = summary.perLayout.find((l) => l.layout === "current");
		const stable = summary.perLayout.find((l) => l.layout === "prefix-stable");
		expect(stable?.cachedReported).toBe(true);
		expect(stable?.meanCachedTokensPass2 ?? 0).toBeGreaterThan(current?.meanCachedTokensPass2 ?? 0);
	});

	it("reports verdict agreement across layouts, and null for a single layout", async () => {
		const session = buildSyntheticSession(RECORDS, 3);
		const multi = new MemoryCacheSink();
		await new CacheRunner({
			meta: meta(["current", "prefix-stable"], session.steps.length),
			layouts: ["current", "prefix-stable"],
			passes: 1,
			session,
			sessionNonce: "n",
			makeCompleter: cachingCompleter([], { calls: 0 }),
			sink: multi,
		}).run();
		const multiSummary = multi.summaries[multi.summaries.length - 1];
		// The verdict depends only on the RISK in the subject, which both layouts carry, so they agree.
		expect(multiSummary.verdictAgreement).not.toBeNull();
		expect(multiSummary.verdictAgreement?.rate).toBe(1);

		const single = new MemoryCacheSink();
		const solo = await new CacheRunner({
			meta: meta(["current"], session.steps.length),
			layouts: ["current"],
			passes: 1,
			session,
			sessionNonce: "n",
			makeCompleter: cachingCompleter([], { calls: 0 }),
			sink: single,
		}).run();
		expect(solo.verdictAgreement).toBeNull();
	});

	it("stops early on abort and does not persist work past the abort", async () => {
		const layouts: JudgeLayout[] = ["current", "prefix-stable"];
		const session = buildSyntheticSession(RECORDS, 3);
		const sink = new MemoryCacheSink();
		const runner = new CacheRunner({
			meta: meta(layouts, session.steps.length),
			layouts,
			passes: 2,
			session,
			sessionNonce: "n",
			makeCompleter: cachingCompleter([], { calls: 0 }),
			sink,
			onProgress: (p) => {
				if (p.done === 2) runner.abort();
			},
		});
		await runner.run();
		expect(runner.signal.aborted).toBe(true);
		// Aborted after the 2nd record; no further records are appended.
		expect(sink.records).toHaveLength(2);
	});
});

describe("computeCacheSummary", () => {
	it("computes per-layout latency means and the pass1/pass2 ratio", () => {
		const records: CacheRecord[] = [
			row("prefix-stable", 1, 1, 100, 0),
			row("prefix-stable", 1, 2, 100, 0),
			row("prefix-stable", 2, 1, 20, 900),
			row("prefix-stable", 2, 2, 20, 900),
		];
		const summary = computeCacheSummary(meta(["prefix-stable"], 2), records);
		const l = summary.perLayout[0];
		expect(l.meanLatencyPass1).toBe(100);
		expect(l.meanLatencyPass2).toBe(20);
		expect(l.latencyRatio).toBe(5);
		expect(l.cachedReported).toBe(true);
	});

	it("marks cache unreported when every cached count is zero", () => {
		const records: CacheRecord[] = [row("current", 1, 1, 50, 0), row("current", 2, 1, 50, 0)];
		const summary = computeCacheSummary(meta(["current"], 1), records);
		expect(summary.perLayout[0].cachedReported).toBe(false);
	});
});

function row(
	layout: JudgeLayout,
	pass: number,
	call: number,
	latencyMs: number,
	cachedTokens: number,
): CacheRecord {
	return {
		layout,
		pass,
		call,
		promptTokens: 1000,
		cachedTokens,
		latencyMs,
		available: true,
		risk: "low",
		error: null,
	};
}
