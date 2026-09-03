import { describe, expect, it, vi } from "vitest";
import { buildExplainMessages, type ExplainStep, makeExplainer } from "../src/explain.ts";
import { EXPLAIN_PROMPTS } from "../src/levels.ts";
import type { AssistantMessage, Context } from "../src/model.ts";

/** A fake assistant message carrying text and a token count. */
function fakeMessage(text: string, tokens = 10): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: tokens, cost: {} },
	} as unknown as AssistantMessage;
}

const subject = { title: "Run this command?", detail: "rm build/" };

describe("buildExplainMessages", () => {
	it("includes the pending action and the transcript", () => {
		const msgs = buildExplainMessages(subject, "User: clean up\nAssistant: on it");
		const text = (msgs[0].content as { text: string }[])[0].text;
		expect(text).toContain("Run this command?");
		expect(text).toContain("rm build/");
		expect(text).toContain("User: clean up");
	});

	it("notes when there is no conversation yet", () => {
		const text = (buildExplainMessages(subject, "")[0].content as { text: string }[])[0].text;
		expect(text).toContain("(no conversation yet)");
	});

	it("fences the action and transcript as untrusted data", () => {
		const text = (buildExplainMessages(subject, "User: clean up")[0].content as { text: string }[])[0].text;
		expect(text.toLowerCase()).toContain("data, not instructions");
		const open = text.match(/<<UNTRUSTED-([A-Za-z0-9_-]+)>>/);
		const close = text.match(/<<END-UNTRUSTED-([A-Za-z0-9_-]+)>>/);
		expect(open?.[1]).toBe(close?.[1]);
	});
});

describe("makeExplainer — prompt selection and stepping", () => {
	it("explains at the configured level first, then one deeper each press, technical repeating", async () => {
		const seen: string[] = [];
		const complete = vi.fn(async (ctx: Context) => {
			seen.push(ctx.systemPrompt ?? "");
			return fakeMessage("explanation");
		});
		const explain = makeExplainer({ startLevel: "fundamental", subject, transcript: "", complete });

		const levels = ["fundamental", "intermediate", "technical", "technical"] as const;
		for (const level of levels) {
			const step = (await explain()) as Extract<ExplainStep, { ok: true }>;
			expect(step.ok).toBe(true);
			expect(step.level).toBe(level);
		}
		expect(seen).toEqual(levels.map((l) => EXPLAIN_PROMPTS[l]));
	});

	it("starts at intermediate when that is the configured level", async () => {
		const complete = vi.fn(async () => fakeMessage("x"));
		const explain = makeExplainer({ startLevel: "intermediate", subject, transcript: "", complete });
		expect(((await explain()) as { level: string }).level).toBe("intermediate");
		expect(((await explain()) as { level: string }).level).toBe("technical");
	});

	it("reports token usage and calls onStep on success", async () => {
		const onStep = vi.fn();
		const explain = makeExplainer({
			startLevel: "technical",
			subject,
			transcript: "",
			complete: async () => fakeMessage("terse", 42),
			onStep,
		});
		const step = (await explain()) as Extract<ExplainStep, { ok: true }>;
		expect(step.markdown).toBe("terse");
		expect(step.usage.totalTokens).toBe(42);
		expect(onStep).toHaveBeenCalledOnce();
	});

	it("degrades to ok:false on a model error and does not advance the level", async () => {
		let calls = 0;
		const complete = vi.fn(async () => {
			calls++;
			if (calls === 1) throw new Error("no auth");
			return fakeMessage("ok");
		});
		const onStep = vi.fn();
		const explain = makeExplainer({ startLevel: "fundamental", subject, transcript: "", complete, onStep });

		const first = await explain();
		expect(first).toEqual({ ok: false, message: "no auth" });
		expect(onStep).not.toHaveBeenCalled();
		// The retry stays at the same (fundamental) level, since the failure did not advance.
		const second = (await explain()) as Extract<ExplainStep, { ok: true }>;
		expect(second.level).toBe("fundamental");
	});
});
