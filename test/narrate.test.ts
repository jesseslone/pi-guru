import { describe, expect, it, vi } from "vitest";
import { NARRATION_PROMPTS } from "../src/levels.ts";
import type { AssistantMessage, Context } from "../src/model.ts";
import { assistantTextOf, buildNarrationMessages, collectReadCalls, runNarration } from "../src/narrate.ts";

function fakeMessage(text: string, tokens = 7): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: tokens, cost: {} },
	} as unknown as AssistantMessage;
}

/** A turn message with the given tool-call and text blocks. */
function turn(content: unknown) {
	return { role: "assistant", content };
}

describe("collectReadCalls — per turn", () => {
	it("keeps read calls and drops change calls", () => {
		const message = turn([
			{ type: "text", text: "checking" },
			{ type: "toolCall", name: "read", arguments: { path: "a.ts" } },
			{ type: "toolCall", name: "grep", arguments: { pattern: "x" } },
			{ type: "toolCall", name: "bash", arguments: { command: "rm x" } },
			{ type: "toolCall", name: "write", arguments: { path: "b.ts" } },
		]);
		const reads = collectReadCalls(message);
		expect(reads.map((r) => r.toolName)).toEqual(["read", "grep"]);
		expect(reads[0].arguments).toEqual({ path: "a.ts" });
	});

	it("treats a configured read-only tool as a read call", () => {
		const message = turn([{ type: "toolCall", name: "docs_lookup", arguments: {} }]);
		expect(collectReadCalls(message).length).toBe(0);
		expect(collectReadCalls(message, ["docs_lookup"]).map((r) => r.toolName)).toEqual(["docs_lookup"]);
	});

	it("returns nothing for a turn with no tool calls or odd content", () => {
		expect(collectReadCalls(turn([{ type: "text", text: "just talking" }]))).toEqual([]);
		expect(collectReadCalls(turn("a string"))).toEqual([]);
		expect(collectReadCalls(undefined)).toEqual([]);
	});
});

describe("assistantTextOf", () => {
	it("joins text blocks and handles a plain string", () => {
		expect(
			assistantTextOf(
				turn([
					{ type: "text", text: "one" },
					{ type: "text", text: "two" },
				]),
			),
		).toBe("one\ntwo");
		expect(assistantTextOf(turn("plain"))).toBe("plain");
		expect(assistantTextOf(turn([{ type: "toolCall", name: "read" }]))).toBe("");
	});
});

describe("buildNarrationMessages", () => {
	it("carries the assistant's own words and the read list", () => {
		const text = (
			buildNarrationMessages([{ toolName: "read", arguments: { path: "a.ts" } }], "I opened the config")[0]
				.content as { text: string }[]
		)[0].text;
		expect(text).toContain("I opened the config");
		expect(text).toContain("read");
		expect(text).toContain("a.ts");
	});

	it("notes when the assistant said nothing", () => {
		const text = (buildNarrationMessages([], "")[0].content as { text: string }[])[0].text;
		expect(text).toContain("the assistant said nothing this turn");
	});
});

describe("runNarration", () => {
	it("returns the account and its token usage, at the level's prompt", async () => {
		let seenPrompt = "";
		const complete = vi.fn(async (ctx: Context) => {
			seenPrompt = ctx.systemPrompt ?? "";
			return fakeMessage("It read the config file to find the port.", 21);
		});
		const out = await runNarration({
			level: "fundamental",
			reads: [{ toolName: "read", arguments: { path: "config.ts" } }],
			assistantText: "Let me check the config",
			complete,
		});
		expect(out.markdown).toContain("config file");
		expect(out.usage.totalTokens).toBe(21);
		expect(seenPrompt).toBe(NARRATION_PROMPTS.fundamental);
	});
});
