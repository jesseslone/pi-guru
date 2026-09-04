import { describe, expect, it, vi } from "vitest";
import {
	buildJudgeMessages,
	CircuitBreaker,
	decideJudgeAction,
	type JudgeDeps,
	type JudgeOutcome,
	parseVerdict,
	type RiskLevel,
	runJudge,
	type Threshold,
	unavailableHeader,
	type Verdict,
	verdictBadge,
	withinThreshold,
} from "../src/judge.ts";
import type { AssistantMessage, Usage } from "../src/model.ts";

const USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** A fake assistant message carrying one text block. */
function reply(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: USAGE,
		timestamp: Date.now(),
	} as unknown as AssistantMessage;
}

describe("parseVerdict", () => {
	it("parses a strict-JSON verdict", () => {
		expect(parseVerdict('{"risk":"medium","rationale":"edits a tracked file"}')).toEqual({
			risk: "medium",
			rationale: "edits a tracked file",
		});
	});

	it("strips a ```json code fence", () => {
		const fenced = '```json\n{"risk":"low","rationale":"reads then writes locally"}\n```';
		expect(parseVerdict(fenced)).toEqual({ risk: "low", rationale: "reads then writes locally" });
	});

	it("strips a bare ``` fence", () => {
		const fenced = '```\n{"risk":"high","rationale":"deletes the repo"}\n```';
		expect(parseVerdict(fenced)?.risk).toBe("high");
	});

	it("finds the first JSON object amid surrounding prose", () => {
		const noisy =
			'Sure — here is my verdict:\n{"risk":"high","rationale":"pipes a script to sh"} Hope that helps!';
		expect(parseVerdict(noisy)).toEqual({ risk: "high", rationale: "pipes a script to sh" });
	});

	it("handles braces inside the rationale string", () => {
		const tricky = '{"risk":"low","rationale":"writes a { and } to a file"}';
		expect(parseVerdict(tricky)?.rationale).toBe("writes a { and } to a file");
	});

	it("returns null for malformed JSON", () => {
		expect(parseVerdict('{"risk":"low", "rationale": ')).toBeNull();
		expect(parseVerdict("not json at all")).toBeNull();
		expect(parseVerdict("")).toBeNull();
	});

	it("returns null for an invalid or missing risk", () => {
		expect(parseVerdict('{"risk":"severe","rationale":"x"}')).toBeNull();
		expect(parseVerdict('{"rationale":"x"}')).toBeNull();
	});

	it("returns null for a missing or empty rationale", () => {
		expect(parseVerdict('{"risk":"low"}')).toBeNull();
		expect(parseVerdict('{"risk":"low","rationale":"   "}')).toBeNull();
	});

	it("trims the rationale", () => {
		expect(parseVerdict('{"risk":"low","rationale":"  tidy  "}')?.rationale).toBe("tidy");
	});

	it("rejects a reply carrying more than one top-level object (fails closed to the gate)", () => {
		// Two verdict objects — whatever the cause (injection, echoed content, model confusion) —
		// is anomalous, so the reply is rejected rather than gambling on an ordering heuristic.
		expect(parseVerdict('{"risk":"low","rationale":"a"} {"risk":"high","rationale":"b"}')).toBeNull();
		// Order does not matter: a trailing benign object cannot win either.
		expect(parseVerdict('{"risk":"high","rationale":"b"}\n{"risk":"low","rationale":"a"}')).toBeNull();
	});

	it("strips control characters and newlines from the rationale, flattening it to one line", () => {
		const v = parseVerdict('{"risk":"low","rationale":"line one\\nline two\\ttabbed\\u0007bell"}');
		expect(v?.rationale).toBe("line one line two tabbed bell");
	});

	it("returns null when the rationale is only control characters (empty after cleaning)", () => {
		expect(parseVerdict('{"risk":"low","rationale":"\\n\\t\\u0000"}')).toBeNull();
	});

	it("caps a very long rationale so it cannot flood the gate header", () => {
		const long = "x".repeat(500);
		const rationale = parseVerdict(`{"risk":"low","rationale":"${long}"}`)?.rationale ?? "";
		expect(rationale.length).toBeLessThanOrEqual(201); // 200 chars + ellipsis
		expect(rationale.endsWith("…")).toBe(true);
	});
});

describe("buildJudgeMessages", () => {
	it("fences the pending action and the transcript as untrusted data", () => {
		const msgs = buildJudgeMessages(
			{ title: "Run this command?", detail: "rm build/" },
			"User: clean up\nAssistant: on it",
		);
		const text = (msgs[0].content as { text: string }[])[0].text;
		expect(text).toContain("Run this command?");
		expect(text).toContain("rm build/");
		expect(text).toContain("User: clean up");
		expect(text.toLowerCase()).toContain("data, not instructions");
		const open = text.match(/<<UNTRUSTED-([A-Za-z0-9_-]+)>>/);
		const close = text.match(/<<END-UNTRUSTED-([A-Za-z0-9_-]+)>>/);
		expect(open?.[1]).toBe(close?.[1]);
	});

	it("notes when there is no conversation yet", () => {
		const text = (buildJudgeMessages({ title: "t", detail: "d" }, "")[0].content as { text: string }[])[0]
			.text;
		expect(text).toContain("(no conversation yet)");
	});
});

describe("withinThreshold", () => {
	const cases: [RiskLevel, Threshold, boolean][] = [
		["low", "low", true],
		["medium", "low", false],
		["high", "low", false],
		["low", "medium", true],
		["medium", "medium", true],
		["high", "medium", false],
	];
	it.each(cases)("risk %s vs threshold %s → %s", (risk, threshold, expected) => {
		expect(withinThreshold(risk, threshold)).toBe(expected);
	});
});

describe("decideJudgeAction", () => {
	const verdict = (risk: RiskLevel): JudgeOutcome => ({
		available: true,
		verdict: { risk, rationale: `${risk} thing` },
		usage: USAGE,
	});

	it("advise always gates, whatever the risk", () => {
		for (const risk of ["low", "medium", "high"] as RiskLevel[]) {
			const action = decideJudgeAction("advise", "medium", verdict(risk));
			expect(action.kind).toBe("gate");
			if (action.kind === "gate") expect(action.header).toContain(risk.toUpperCase());
		}
	});

	it("auto/low auto-approves low, gates medium and high", () => {
		expect(decideJudgeAction("auto", "low", verdict("low")).kind).toBe("auto-approve");
		expect(decideJudgeAction("auto", "low", verdict("medium")).kind).toBe("gate");
		expect(decideJudgeAction("auto", "low", verdict("high")).kind).toBe("gate");
	});

	it("auto/medium auto-approves low and medium, always gates high", () => {
		expect(decideJudgeAction("auto", "medium", verdict("low")).kind).toBe("auto-approve");
		expect(decideJudgeAction("auto", "medium", verdict("medium")).kind).toBe("auto-approve");
		expect(decideJudgeAction("auto", "medium", verdict("high")).kind).toBe("gate");
	});

	it("an unavailable verdict always gates with a judge-unavailable header (never allows)", () => {
		const failure: JudgeOutcome = { available: false, reason: "timed out" };
		for (const mode of ["advise", "auto"] as const) {
			const action = decideJudgeAction(mode, "medium", failure);
			expect(action.kind).toBe("gate");
			if (action.kind === "gate") expect(action.header).toBe("judge unavailable: timed out");
		}
	});
});

describe("verdictBadge / unavailableHeader", () => {
	it("formats a badge with the risk in caps and the rationale", () => {
		const v: Verdict = { risk: "medium", rationale: "recoverable with effort" };
		expect(verdictBadge(v)).toBe("[MEDIUM RISK] recoverable with effort");
	});
	it("formats an unavailable header with the reason", () => {
		expect(unavailableHeader("no session model available")).toBe(
			"judge unavailable: no session model available",
		);
	});
});

describe("CircuitBreaker", () => {
	it("trips on three consecutive medium-risk auto-approvals", () => {
		const b = new CircuitBreaker();
		expect(b.record("medium", true)).toBe(false);
		expect(b.record("medium", true)).toBe(false);
		expect(b.record("medium", true)).toBe(true);
		expect(b.tripped).toBe(true);
	});

	it("a low-risk auto-approval resets the medium streak", () => {
		const b = new CircuitBreaker();
		b.record("medium", true);
		b.record("medium", true);
		b.record("low", true); // resets
		expect(b.record("medium", true)).toBe(false);
		expect(b.tripped).toBe(false);
	});

	it("a gated (non-auto-approved) medium does not build the streak", () => {
		const b = new CircuitBreaker();
		b.record("medium", true);
		b.record("medium", false); // gated — not an auto-approval
		expect(b.record("medium", true)).toBe(false);
		expect(b.tripped).toBe(false);
	});

	it("trips on ten auto-approvals within the last fifty judged calls", () => {
		const b = new CircuitBreaker();
		// 9 low auto-approvals interleaved with gates — no medium streak, under the window cap.
		for (let i = 0; i < 9; i++) {
			b.record("low", true);
			b.record("high", false);
		}
		expect(b.tripped).toBe(false);
		expect(b.record("low", true)).toBe(true); // the tenth auto-approval trips it
	});

	it("drops old calls out of the fifty-call window", () => {
		const b = new CircuitBreaker();
		// 9 low auto-approvals, then 50 gated calls push them out of the window.
		for (let i = 0; i < 9; i++) b.record("low", true);
		for (let i = 0; i < 50; i++) b.record("high", false);
		expect(b.tripped).toBe(false);
		// Nine fresh auto-approvals still under ten in the (now mostly-gated) window.
		for (let i = 0; i < 9; i++) expect(b.record("low", true)).toBe(false);
	});

	it("reset() un-trips a tripped breaker (setting a gate level or /judge, the design notes)", () => {
		const b = new CircuitBreaker();
		b.record("medium", true);
		b.record("medium", true);
		expect(b.record("medium", true)).toBe(true); // tripped on the medium streak
		expect(b.tripped).toBe(true);
		b.reset();
		expect(b.tripped).toBe(false);
		// The medium streak is cleared too: two fresh mediums do not re-trip immediately.
		expect(b.record("medium", true)).toBe(false);
		expect(b.record("medium", true)).toBe(false);
	});

	it("reset() clears the fifty-call window, not just the medium streak", () => {
		const b = new CircuitBreaker();
		for (let i = 0; i < 9; i++) b.record("low", true);
		expect(b.record("low", true)).toBe(true); // the tenth auto-approval trips the window rule
		b.reset();
		expect(b.tripped).toBe(false);
		// Nine fresh low auto-approvals are back under ten — the old window is gone.
		for (let i = 0; i < 9; i++) expect(b.record("low", true)).toBe(false);
	});
});

describe("runJudge", () => {
	const deps = (complete: JudgeDeps["complete"]): JudgeDeps => ({
		level: "intermediate",
		subject: { title: "Run this command?", detail: "rm foo" },
		transcript: "User: tidy up\nAssistant: I'll remove foo",
		complete,
	});

	it("returns an available verdict when the model replies with valid JSON", async () => {
		const complete = vi.fn(async () => reply('{"risk":"medium","rationale":"removes a file"}'));
		const outcome = await runJudge(deps(complete));
		expect(outcome).toEqual({
			available: true,
			verdict: { risk: "medium", rationale: "removes a file" },
			usage: USAGE,
		});
		expect(complete).toHaveBeenCalledOnce();
	});

	it("is unavailable when the reply cannot be parsed, keeping the raw reply", async () => {
		const outcome = await runJudge(deps(async () => reply("I think it's probably fine?")));
		expect(outcome).toEqual({
			available: false,
			reason: "unparseable verdict",
			raw: "I think it's probably fine?",
		});
	});

	it("is unavailable (with the error message) when the model call throws", async () => {
		const outcome = await runJudge(
			deps(async () => {
				throw new Error("aborted");
			}),
		);
		expect(outcome).toEqual({ available: false, reason: "aborted" });
	});
});
