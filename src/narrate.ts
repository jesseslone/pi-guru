/**
 * Narration: a plain-language account of the **read calls** made during one turn — what
 * each looked at and why — produced once per turn without stopping the agent (CONTEXT.md,
 * the design notes).
 *
 * The read calls come from the turn's assistant message; the "why" comes from that same
 * message's own text, so the model narrates reasons the assistant actually gave rather than
 * inventing them. One `complete` call per turn, at the current level, skipped when the turn
 * read nothing or the level is off. The model call is injected so this is unit-testable.
 */

import { classifyTool } from "./classify.ts";
import { NARRATION_PROMPTS, type SpokenLevel } from "./levels.ts";
import { type Completer, completionText, type Usage, userMessage } from "./model.ts";

/** A content block of an assistant message (text or tool call). */
interface ContentBlock {
	type?: string;
	text?: string;
	name?: string;
	arguments?: Record<string, unknown>;
}

/** A single read call made during a turn. */
export interface ReadCall {
	toolName: string;
	arguments: Record<string, unknown>;
}

/** The content array of a turn's assistant message, however the message is shaped. */
function contentOf(message: unknown): unknown {
	return message && typeof message === "object" ? (message as { content?: unknown }).content : undefined;
}

/** The read calls of a turn, in order. Change calls are excluded (they gate, not narrate). */
export function collectReadCalls(message: unknown, readOnlyTools: readonly string[] = []): ReadCall[] {
	const content = contentOf(message);
	if (!Array.isArray(content)) return [];
	const reads: ReadCall[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const block = part as ContentBlock;
		if (block.type !== "toolCall" || typeof block.name !== "string") continue;
		if (classifyTool(block.name, readOnlyTools) !== "read") continue;
		reads.push({ toolName: block.name, arguments: block.arguments ?? {} });
	}
	return reads;
}

/** The assistant's own words for the turn — the only allowed source of "why". */
export function assistantTextOf(message: unknown): string {
	const content = contentOf(message);
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const block = part as ContentBlock;
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n").trim();
}

/** Build the user message: the assistant's words plus the list of reads. */
export function buildNarrationMessages(reads: ReadCall[], assistantText: string) {
	const readLines = reads.map((r) => `- ${r.toolName} ${JSON.stringify(r.arguments)}`).join("\n");
	const text = [
		"Narrate what the assistant just read, for the person supervising it.",
		"",
		"<assistant-said>",
		assistantText || "(the assistant said nothing this turn)",
		"</assistant-said>",
		"",
		"<reads>",
		readLines,
		"</reads>",
	].join("\n");
	return userMessage(text);
}

/** A produced narration: the rendered account and the tokens it cost. */
export interface Narration {
	markdown: string;
	usage: Usage;
}

export interface NarrateDeps {
	level: SpokenLevel;
	reads: ReadCall[];
	assistantText: string;
	complete: Completer;
}

/**
 * Run one narration call. The caller decides whether to call this at all (it skips when
 * the level is off or there were no reads); this asserts there is something to narrate.
 */
export async function runNarration(deps: NarrateDeps): Promise<Narration> {
	const response = await deps.complete({
		systemPrompt: NARRATION_PROMPTS[deps.level],
		messages: buildNarrationMessages(deps.reads, deps.assistantText),
	});
	return { markdown: completionText(response), usage: response.usage };
}
