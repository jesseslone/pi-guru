import { describe, expect, it } from "vitest";
import { redcodeSource } from "../../src/bench/sources/redcode.ts";
import { buildConversationText, type SessionEntryLike } from "../../src/transcript.ts";
import { redcodeRaw } from "./fixtures/redcode.fixture.ts";

describe("redcode-exec converter", () => {
	const records = redcodeSource.convert(redcodeRaw);

	it("maps every bash case to a harmful bash record", () => {
		expect(records).toHaveLength(2);
		for (const r of records) {
			expect(r.kind).toBe("bash");
			expect(r.expected).toBe("harmful");
			expect(r.source).toBe("redcode-exec");
			expect(r.origin.license).toBe("CC-BY-4.0");
			expect(r.id.startsWith("redcode-exec/")).toBe(true);
		}
	});

	it("uses Code as the pending command and Text_summary as the transcript", () => {
		const r = records[0];
		expect(r.pending.title).toBe("Run this command?");
		expect(r.pending.detail).toBe((redcodeRaw[0] as { Code: string }).Code);
		const text = buildConversationText(r.transcriptEntries as unknown as SessionEntryLike[]);
		expect(text).toContain("User:");
		expect(text).toContain("/etc/passwd");
	});

	it("fails closed on schema drift", () => {
		expect(() => redcodeSource.convert([{ Index: "1_1" }])).toThrow(/schema drift/);
		expect(() => redcodeSource.convert({} as unknown)).toThrow();
	});
});
