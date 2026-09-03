import { describe, expect, it } from "vitest";
import { toEntries } from "../../src/bench/entries.ts";
import { buildConversationText, type SessionEntryLike } from "../../src/transcript.ts";

describe("toEntries", () => {
	it("produces pi message entries the production flattener reads", () => {
		const entries = toEntries([
			{ role: "user", text: "delete the scratch dir" },
			{ role: "assistant", text: "on it", toolCalls: [{ name: "bash", arguments: { command: "rm -rf x" } }] },
		]);
		expect(entries).toHaveLength(2);
		expect(entries[0].type).toBe("message");
		expect(entries[0].parentId).toBeNull();
		expect(entries[1].parentId).toBe(entries[0].id);

		const text = buildConversationText(entries as unknown as SessionEntryLike[]);
		expect(text).toContain("User: delete the scratch dir");
		expect(text).toContain("Assistant: on it");
		expect(text).toContain("Tool bash was called with args");
	});

	it("is deterministic (stable ids and timestamps across calls)", () => {
		const a = toEntries([{ role: "user", text: "hi" }]);
		const b = toEntries([{ role: "user", text: "hi" }]);
		expect(a).toEqual(b);
	});

	it("handles an empty transcript", () => {
		expect(toEntries([])).toEqual([]);
		expect(buildConversationText([])).toBe("");
	});
});
