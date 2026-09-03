import { describe, expect, it } from "vitest";
import {
	buildConversationText,
	entriesToMessages,
	extractTextParts,
	extractToolCallLines,
	type SessionEntryLike,
} from "../src/transcript.ts";

describe("extractTextParts", () => {
	it("handles a string, a block array, and junk", () => {
		expect(extractTextParts("hi")).toEqual(["hi"]);
		expect(extractTextParts([{ type: "text", text: "a" }, { type: "toolCall", name: "read" }, null])).toEqual(
			["a"],
		);
		expect(extractTextParts(42)).toEqual([]);
	});
});

describe("extractToolCallLines", () => {
	it("renders one line per tool call with its args", () => {
		const lines = extractToolCallLines([
			{ type: "text", text: "ignore" },
			{ type: "toolCall", name: "read", arguments: { path: "a.ts" } },
		]);
		expect(lines).toEqual(['Tool read was called with args {"path":"a.ts"}']);
	});
});

describe("buildConversationText — flattening", () => {
	it("flattens user and assistant text plus assistant tool calls, skipping other entries", () => {
		const entries: SessionEntryLike[] = [
			{ type: "message", message: { role: "user", content: "find the bug" } },
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "Looking now" },
						{ type: "toolCall", name: "grep", arguments: { pattern: "bug" } },
					],
				},
			},
			{ type: "message", message: { role: "toolResult", content: "..." } },
			{ type: "custom", message: { role: "assistant", content: "not a message entry" } },
		];
		const text = buildConversationText(entries);
		expect(text).toContain("User: find the bug");
		expect(text).toContain("Assistant: Looking now");
		expect(text).toContain('Tool grep was called with args {"pattern":"bug"}');
		expect(text).not.toContain("not a message entry");
		expect(text).not.toContain("toolResult");
	});

	it("returns an empty string when there is nothing to flatten", () => {
		expect(buildConversationText([])).toBe("");
	});
});

describe("entriesToMessages — for the shared-prefix layout", () => {
	it("keeps user/assistant/toolResult messages and drops non-message entries", () => {
		const entries: SessionEntryLike[] = [
			{ type: "message", message: { role: "user", content: "hi" } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "yo" }] } },
			{ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "small" }] } },
			{ type: "custom", message: { role: "assistant", content: "nope" } },
		];
		const messages = entriesToMessages(entries) as { role: string }[];
		expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult"]);
	});

	it("truncates an over-long tool-result text block with a marker", () => {
		const big = "x".repeat(5000);
		const entries: SessionEntryLike[] = [
			{ type: "message", message: { role: "toolResult", content: [{ type: "text", text: big }] } },
		];
		const [result] = entriesToMessages(entries, 4000) as { content: { text: string }[] }[];
		const text = result.content[0].text;
		expect(text.length).toBeLessThan(big.length);
		expect(text).toContain("[truncated 1000 chars]");
		expect(text.startsWith("x".repeat(4000))).toBe(true);
	});

	it("passes a short tool result through unchanged", () => {
		const entries: SessionEntryLike[] = [
			{ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "ok" }] } },
		];
		const [result] = entriesToMessages(entries, 4000) as { content: { text: string }[] }[];
		expect(result.content[0].text).toBe("ok");
	});
});
