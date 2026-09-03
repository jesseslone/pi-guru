import { describe, expect, it } from "vitest";
import {
	buildSyntheticSession,
	estimateTokens,
	fillerTurns,
	SYNTHETIC_AGENT_SYSTEM_PROMPT,
} from "../../src/bench/cache-session.ts";
import type { BenchRecord } from "../../src/bench/schema.ts";

/** A minimal bench record for the session builder. */
function rec(id: string, detail: string): BenchRecord {
	return {
		source: "hand-written",
		sourceVersion: "v",
		id,
		category: "c",
		kind: "bash",
		expected: "benign",
		authoredRisk: "low",
		label: "low",
		transcriptEntries: [],
		pending: { title: "Run this command?", detail },
		origin: { url: "", license: "", attribution: "" },
	};
}

const RECORDS = [rec("a", "cmd one"), rec("b", "cmd two"), rec("c", "cmd three"), rec("d", "cmd four")];

describe("buildSyntheticSession", () => {
	it("takes the first `count` records and numbers the steps from 1", () => {
		const session = buildSyntheticSession(RECORDS, 3);
		expect(session.agentSystemPrompt).toBe(SYNTHETIC_AGENT_SYSTEM_PROMPT);
		expect(session.steps.map((s) => s.call)).toEqual([1, 2, 3]);
		expect(session.steps.map((s) => s.subject.detail)).toEqual(["cmd one", "cmd two", "cmd three"]);
	});

	it("grows the transcript monotonically — each step's transcript is a prefix of the next", () => {
		const session = buildSyntheticSession(RECORDS, 4);
		for (let i = 1; i < session.steps.length; i++) {
			const prev = session.steps[i - 1].transcript;
			const cur = session.steps[i].transcript;
			expect(cur.length).toBeGreaterThan(prev.length);
			expect(cur.startsWith(prev)).toBe(true);
		}
	});

	it("grows the agent message array by one turn per step (shared-prefix input)", () => {
		const session = buildSyntheticSession(RECORDS, 4);
		const lengths = session.steps.map((s) => s.agentMessages.length);
		for (let i = 1; i < lengths.length; i++) {
			expect(lengths[i]).toBeGreaterThan(lengths[i - 1]);
		}
	});

	it("never returns zero steps even when count is 0", () => {
		expect(buildSyntheticSession(RECORDS, 0).steps.length).toBe(1);
	});
});

describe("pad-tokens (the design notes item 3)", () => {
	it("adds no filler when padTokens is 0 or absent", () => {
		expect(fillerTurns(0)).toEqual([]);
		const bare = buildSyntheticSession(RECORDS, 2);
		const padded = buildSyntheticSession(RECORDS, 2, { padTokens: 0 });
		expect(padded.steps[0].transcript).toBe(bare.steps[0].transcript);
	});

	it("pads the early transcript to at least the requested token budget, and not far beyond", () => {
		const padTokens = 2000;
		const session = buildSyntheticSession(RECORDS, 2, { padTokens });
		const tokens = estimateTokens(session.steps[0].transcript);
		expect(tokens).toBeGreaterThanOrEqual(padTokens);
		// One filler pair overshoots by at most a few hundred tokens, plus the opening/step framing.
		expect(tokens).toBeLessThan(padTokens + 800);
	});

	it("is deterministic for a given seed and grows the whole session (still monotonic)", () => {
		const a = buildSyntheticSession(RECORDS, 3, { padTokens: 1500, seed: 7 });
		const b = buildSyntheticSession(RECORDS, 3, { padTokens: 1500, seed: 7 });
		expect(a.steps[0].transcript).toBe(b.steps[0].transcript);
		// Padding sits at the front, so the growing-prefix property the stable layouts need still holds.
		for (let i = 1; i < a.steps.length; i++) {
			expect(a.steps[i].transcript.startsWith(a.steps[i - 1].transcript)).toBe(true);
		}
		// A different seed yields different filler text.
		const c = buildSyntheticSession(RECORDS, 3, { padTokens: 1500, seed: 8 });
		expect(c.steps[0].transcript).not.toBe(a.steps[0].transcript);
	});
});
