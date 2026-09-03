import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { handoffTimestamp, renderHandoff, writeHandoff } from "../src/handoff.ts";

const details = {
	toolName: "bash",
	attempted: "echo hi > notes.txt",
	reason:
		"pi-guru: no one is here to review this change. Run pi interactively to decide at the gate, or turn on the judge's auto mode to let it approve low-risk changes for you.",
};

describe("handoffTimestamp", () => {
	it("has no colons (filesystem-safe)", () => {
		const ts = handoffTimestamp(new Date("2026-09-02T12:34:56.000Z"));
		expect(ts).not.toContain(":");
		expect(ts).toBe("2026-09-02T12-34-56.000Z");
	});
});

describe("renderHandoff", () => {
	it("names what was attempted, why, and what to do next", () => {
		const md = renderHandoff(details, new Date("2026-09-02T12:34:56.000Z"));
		expect(md).toContain("stop handoff");
		expect(md).toContain("bash");
		expect(md).toContain("echo hi > notes.txt");
		expect(md).toContain(details.reason);
		expect(md).toContain("What to do next");
		expect(md).toContain("2026-09-02T12:34:56.000Z");
	});
});

describe("writeHandoff", () => {
	it("writes under .pi/handoffs with a pi-guru-suffixed name", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-guru-handoff-"));
		const date = new Date("2026-09-02T12:34:56.000Z");
		const { path, contents } = writeHandoff(cwd, details, date);
		expect(path).toBe(join(cwd, ".pi", "handoffs", "2026-09-02T12-34-56.000Z-pi-guru.md"));
		expect(readFileSync(path, "utf8")).toBe(contents);
		expect(contents).toContain("echo hi > notes.txt");
	});
});
