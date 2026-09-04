import { describe, expect, it } from "vitest";
import { type GateLevel, isGateLevel, resolveSessionJudge } from "../src/gate-level.ts";
import type { JudgeMode, Threshold } from "../src/judge.ts";

const config = (judgeMode: JudgeMode, judgeThreshold: Threshold = "low") => ({ judgeMode, judgeThreshold });

describe("isGateLevel", () => {
	it("accepts the four levels and rejects anything else", () => {
		for (const l of ["ask", "auto-low", "auto-medium", "off"]) expect(isGateLevel(l)).toBe(true);
		for (const l of ["auto", "yolo", "", undefined, 3]) expect(isGateLevel(l)).toBe(false);
	});
});

describe("resolveSessionJudge — mapping", () => {
	it("ask uses the config's own judge, byte-identical (no override, no gate-off)", () => {
		const r = resolveSessionJudge("ask", config("advise", "medium"));
		expect(r).toMatchObject({
			mode: "advise",
			threshold: "medium",
			gateOff: false,
			appliedLevel: "ask",
			capped: false,
		});
	});

	it("auto-low forces auto/low even when config says off", () => {
		const r = resolveSessionJudge("auto-low", config("off"));
		expect(r).toMatchObject({ mode: "auto", threshold: "low", gateOff: false, appliedLevel: "auto-low" });
	});

	it("auto-medium forces auto/medium even when config says advise", () => {
		const r = resolveSessionJudge("auto-medium", config("advise", "low"));
		expect(r).toMatchObject({
			mode: "auto",
			threshold: "medium",
			gateOff: false,
			appliedLevel: "auto-medium",
		});
	});

	it("off sets gate-off and does not run the judge", () => {
		const r = resolveSessionJudge("off", config("auto", "medium"));
		expect(r).toMatchObject({ gateOff: true, appliedLevel: "off", capped: false });
	});
});

describe("resolveSessionJudge — project cap", () => {
	it("a project that forbids auto (advise) caps every auto/off level down to ask", () => {
		for (const requested of ["auto-low", "auto-medium", "off"] as GateLevel[]) {
			const r = resolveSessionJudge(requested, config("auto", "medium"), { judgeMode: "advise" });
			expect(r.appliedLevel).toBe("ask");
			expect(r.capped).toBe(true);
			expect(r.gateOff).toBe(false);
			expect(r.mode).toBe("auto"); // ask ⇒ the config's own (merged) mode stands
		}
	});

	it("a project that forbids auto (off) also caps to ask", () => {
		const r = resolveSessionJudge("auto-low", config("advise"), { judgeMode: "off" });
		expect(r.appliedLevel).toBe("ask");
		expect(r.capped).toBe(true);
	});

	it("a project threshold of low caps auto-medium and off down to auto-low", () => {
		const medium = resolveSessionJudge("auto-medium", config("auto", "medium"), { judgeThreshold: "low" });
		expect(medium).toMatchObject({ appliedLevel: "auto-low", mode: "auto", threshold: "low", capped: true });
		const off = resolveSessionJudge("off", config("auto", "medium"), { judgeThreshold: "low" });
		expect(off).toMatchObject({ appliedLevel: "auto-low", capped: true, gateOff: false });
	});

	it("a project that permits auto does not cap", () => {
		const r = resolveSessionJudge("auto-medium", config("off"), {
			judgeMode: "auto",
			judgeThreshold: "medium",
		});
		expect(r).toMatchObject({ appliedLevel: "auto-medium", capped: false });
	});

	it("no project config never caps", () => {
		const r = resolveSessionJudge("off", config("off"), undefined);
		expect(r).toMatchObject({ appliedLevel: "off", capped: false, gateOff: true });
	});
});
