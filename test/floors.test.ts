import { describe, expect, it } from "vitest";
import { assess, floorDecision } from "../src/assess/index.ts";
import { applyFloor, decideJudgeAction, type Verdict, verdictBadge } from "../src/judge.ts";
import { normalizeBash } from "../src/normalize.ts";

const ctx = { cwd: "/home/dev/project", home: "/home/dev" };

describe("applyFloor — max(verdict, floor)", () => {
	const low: Verdict = { risk: "low", rationale: "just prints to stdout" };

	it("raises a low verdict to the high floor and records why", () => {
		const out = applyFloor(low, {
			floor: "high",
			factId: "reads-credential-file",
			reason: "reads a credential file",
		});
		expect(out.risk).toBe("high");
		expect(out.flooredBy).toEqual({
			factId: "reads-credential-file",
			reason: "reads a credential file",
			from: "low",
			to: "high",
		});
	});

	it("does not lower a verdict already at or above the floor", () => {
		const high: Verdict = { risk: "high", rationale: "destroys data" };
		const out = applyFloor(high, { floor: "medium", factId: "sudo", reason: "runs with sudo" });
		expect(out.risk).toBe("high");
		expect(out.flooredBy).toBeUndefined();
	});

	it("is a no-op when there is no floor", () => {
		expect(applyFloor(low, undefined)).toEqual(low);
	});
});

describe("verdictBadge — shows the floor note", () => {
	it("appends the raised-to line when floored", () => {
		const v: Verdict = {
			risk: "high",
			rationale: "reads a key",
			flooredBy: {
				factId: "reads-credential-file",
				reason: "reads a credential file",
				from: "low",
				to: "high",
			},
		};
		expect(verdictBadge(v)).toContain("pi-guru raised this to high: reads a credential file");
	});
	it("omits the note when not floored", () => {
		expect(verdictBadge({ risk: "low", rationale: "routine" })).toBe("[LOW RISK] routine");
	});
});

describe("floorDecision — maps assessment facts to a floor", () => {
	it("returns the high floor with a path reason for a credential read", () => {
		const { facts } = assess(normalizeBash("cat ~/.ssh/id_rsa"), ctx);
		const d = floorDecision(facts);
		expect(d?.floor).toBe("high");
		expect(d?.factId).toBe("reads-credential-file");
		expect(d?.reason).toContain("/home/dev/.ssh/id_rsa");
	});
	it("returns undefined when nothing floors", () => {
		expect(floorDecision(assess(normalizeBash("ls -la"), ctx).facts)).toBeUndefined();
	});
});

describe("floor + decideJudgeAction — a floored call is gated in auto mode", () => {
	it("a low verdict floored to high is gated, not auto-approved", () => {
		const floored = applyFloor(
			{ risk: "low", rationale: "read-only" },
			{ floor: "high", factId: "reads-credential-file", reason: "reads a credential file" },
		);
		const action = decideJudgeAction("auto", "medium", {
			available: true,
			verdict: floored,
			usage: {} as never,
		});
		expect(action.kind).toBe("gate");
	});
});
