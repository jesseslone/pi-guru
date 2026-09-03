/**
 * The guarded plain-language reading: interval math, the suppression floor, prompt
 * selection per level, and the no-model / failing-model degrade — all with an injected completer,
 * never a network.
 */

import { describe, expect, it } from "vitest";
import {
	formatReadingFacts,
	generateReading,
	READING_N_FLOOR,
	type ReadingFacts,
	readingFactsForCompare,
	readingFactsForRun,
	spokenOrNull,
	wilson95,
} from "../../src/bench/reading.ts";
import type { RunSummary, SourceSummary } from "../../src/bench/run-result.ts";
import { READING_PROMPTS } from "../../src/levels.ts";
import type { AssistantMessage, Context } from "../../src/model.ts";

/** A fake assistant reply carrying `text` and zero usage. */
function reply(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: {
			input: 5,
			output: 3,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 8,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: 0,
		// biome-ignore lint/suspicious/noExplicitAny: a minimal assistant message for the completer.
	} as any;
}

/** A source summary with the fields the reading reads; everything else is inert. */
function source(over: Partial<SourceSummary> & Pick<SourceSummary, "source" | "n">): SourceSummary {
	return {
		sourceVersion: "v1",
		observations: over.n,
		harmfulN: over.n,
		benignN: over.n,
		letThroughLow: 0.1,
		letThroughMedium: 0.2,
		benignBlocked: 0.05,
		majorityHarmfulN: over.n,
		majorityBenignN: over.n,
		majorityLetThroughLow: 0.1,
		majorityLetThroughMedium: 0.2,
		majorityBenignBlocked: 0.05,
		benignForGateN: 0,
		benignForGateBlocked: null,
		majorityBenignForGateN: 0,
		majorityBenignForGateBlocked: null,
		agreementRate: 1,
		flips: 0,
		flooredMedium: 0,
		flooredHigh: 0,
		raised: 0,
		unavailableRate: 0,
		unavailableTimeout: 0,
		unavailableOther: 0,
		verdictDist: { low: 0, medium: 0, high: 0, unavailable: 0 },
		latencyP50: 100,
		latencyP95: 200,
		pass1LatencyMean: 100,
		laterPassLatencyMean: null,
		...over,
	};
}

function summary(perSource: SourceSummary[]): RunSummary {
	return {
		run: "r",
		model: { provider: "p", id: "m" },
		layout: "current",
		promptVersion: "v1",
		facts: false,
		seed: "s",
		limit: null,
		passes: 1,
		sources: "all",
		timeoutMs: 60000,
		started: "",
		finished: null,
		total: perSource.reduce((a, s) => a + s.n, 0),
		perSource,
		sourceFailed: [],
	};
}

const facts30: ReadingFacts = {
	title: "run r",
	stats: [{ label: "src let-through ≤medium", rate: 0.2, n: 30, interval: { lo: 0.09, hi: 0.39 } }],
	minN: 30,
};

describe("wilson95", () => {
	it("is null when n is zero", () => {
		expect(wilson95(0, 0)).toBeNull();
	});
	it("brackets the point estimate and stays in [0,1]", () => {
		const i = wilson95(50, 100);
		expect(i).not.toBeNull();
		expect(i?.lo).toBeCloseTo(0.4038, 3);
		expect(i?.hi).toBeCloseTo(0.5962, 3);
	});
	it("handles the zero-success extreme without going negative", () => {
		const i = wilson95(0, 10);
		expect(i?.lo).toBe(0);
		expect(i?.hi).toBeCloseTo(0.2775, 3);
	});
	it("handles the all-success extreme without exceeding one", () => {
		const i = wilson95(10, 10);
		expect(i?.hi).toBeCloseTo(1, 9);
		expect(i?.hi).toBeLessThanOrEqual(1);
		expect(i?.lo).toBeCloseTo(0.7225, 3);
	});
});

describe("readingFactsForRun", () => {
	it("emits one stat per defined rate and tracks the smallest source N", () => {
		const facts = readingFactsForRun(
			summary([source({ source: "big", n: 40 }), source({ source: "small", n: 12 })]),
		);
		expect(facts.minN).toBe(12);
		expect(facts.stats.some((s) => s.label.includes("big let-through ≤medium"))).toBe(true);
		expect(facts.stats.every((s) => s.interval.lo <= s.rate + 1e-9 && s.rate <= s.interval.hi + 1e-9)).toBe(
			true,
		);
	});
});

describe("readingFactsForCompare", () => {
	it("labels each stat with its model so a cross-model reading is possible", () => {
		const a = summary([source({ source: "s", n: 40 })]);
		a.model = { provider: "x", id: "a" };
		const b = summary([source({ source: "s", n: 40 })]);
		b.model = { provider: "x", id: "b" };
		const facts = readingFactsForCompare([a, b]);
		expect(facts.stats.some((s) => s.label.startsWith("x/a"))).toBe(true);
		expect(facts.stats.some((s) => s.label.startsWith("x/b"))).toBe(true);
	});
});

describe("formatReadingFacts", () => {
	it("renders each rate with its N and a 95% CI, and nothing else", () => {
		const text = formatReadingFacts(facts30);
		expect(text).toContain("n=30");
		expect(text).toContain("95% CI");
		expect(text).toContain("20.0%");
	});
});

describe("generateReading — suppression", () => {
	it("suppresses when any per-source N is below the floor, without calling the model", async () => {
		let called = false;
		const complete = async () => {
			called = true;
			return reply("should not run");
		};
		const facts: ReadingFacts = { ...facts30, minN: READING_N_FLOOR - 1 };
		const result = await generateReading({ level: "technical", facts, complete });
		expect(result.kind).toBe("suppressed");
		expect(called).toBe(false);
		if (result.kind === "suppressed") expect(result.note).toMatch(/suppressed/);
	});

	it("suppresses when there are no scored rates", async () => {
		const result = await generateReading({
			level: "technical",
			facts: { title: "t", stats: [], minN: 0 },
			complete: async () => reply("x"),
		});
		expect(result.kind).toBe("suppressed");
	});
});

describe("generateReading — prompt selection per level", () => {
	for (const level of ["fundamental", "intermediate", "technical"] as const) {
		it(`uses READING_PROMPTS.${level} as the system prompt`, async () => {
			const seen: (string | undefined)[] = [];
			const complete = async (ctx: Context) => {
				seen.push(ctx.systemPrompt);
				return reply("A three sentence reading. It is careful. It cites the intervals.");
			};
			const result = await generateReading({ level, facts: facts30, complete });
			expect(result.kind).toBe("reading");
			expect(seen).toEqual([READING_PROMPTS[level]]);
		});
	}
});

describe("generateReading — no-model degrade", () => {
	it("returns an unavailable note when there is no completer, making no network call", async () => {
		const result = await generateReading({ level: "technical", facts: facts30, complete: null });
		expect(result.kind).toBe("unavailable");
		if (result.kind === "unavailable") expect(result.note).toMatch(/no session model/);
	});

	it("returns an unavailable note when the model call throws (e.g. a timeout)", async () => {
		const complete = async () => {
			throw new Error("The operation was aborted due to timeout");
		};
		const result = await generateReading({ level: "technical", facts: facts30, complete });
		expect(result.kind).toBe("unavailable");
		if (result.kind === "unavailable") expect(result.note).toMatch(/timeout/);
	});
});

describe("spokenOrNull", () => {
	it("maps off to null and spoken levels to themselves", () => {
		expect(spokenOrNull("off")).toBeNull();
		expect(spokenOrNull("technical")).toBe("technical");
	});
});
