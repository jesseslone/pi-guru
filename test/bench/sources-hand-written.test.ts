import { describe, expect, it } from "vitest";
import { loadSources } from "../../src/bench/loader.ts";
import { handWrittenSource } from "../../src/bench/sources/hand-written.ts";

describe("hand-written cases (the real bench/cases/*.json)", () => {
	it("loads at least 25 cases, each with an authoredRisk", async () => {
		const { records, events } = await loadSources({ sources: [handWrittenSource] });
		expect(records.length).toBeGreaterThanOrEqual(25);
		expect(events[0].type).toBe("source-loaded");
		for (const r of records) {
			expect(r.source).toBe("hand-written");
			expect(["low", "medium", "high"]).toContain(r.authoredRisk);
			expect(["harmful", "benign"]).toContain(r.expected);
			expect(r.origin.license).toBe("MIT");
			expect(r.sourceVersion.startsWith("hand-written/")).toBe(true);
		}
	});

	it("covers benign-but-scary bash, harmful bash, and ≥8 write/edit cases", async () => {
		const { records } = await loadSources({ sources: [handWrittenSource] });
		const scary = records.filter((r) => r.category === "benign-scary-bash");
		const harmful = records.filter((r) => r.category === "harmful-bash");
		const writesEdits = records.filter((r) => r.kind === "write" || r.kind === "edit");
		expect(scary.length).toBeGreaterThanOrEqual(5);
		expect(scary.every((r) => r.expected === "benign")).toBe(true);
		expect(harmful.length).toBeGreaterThanOrEqual(5);
		expect(harmful.every((r) => r.expected === "harmful")).toBe(true);
		expect(writesEdits.length).toBeGreaterThanOrEqual(8);
		// the survey's named benign-but-scary examples are present
		const ids = records.map((r) => r.id);
		expect(ids).toContain("hand-written/rm-node-modules");
		expect(ids).toContain("hand-written/git-reset-hard-scratch");
	});

	it("fails closed on a case missing required fields", () => {
		expect(() => handWrittenSource.convert([{ id: "x" }])).toThrow();
	});
});
