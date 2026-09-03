/**
 * Flatten session entries into a plain transcript string for a model call.
 *
 * This is the `buildConversationText` pattern from pi's `examples/extensions/summarize.ts`
 * (MIT), reused so Explain and, later, the judge  can hand the session
 * model a readable account of the conversation. Session entries are raw `SessionEntry`
 * objects, not provider `Message`s, so we flatten them by duck-typing the content blocks —
 * exactly as summarize.ts does.
 */

/** A content block inside a message entry (text, or a tool call). */
interface ContentBlock {
	type?: string;
	text?: string;
	name?: string;
	arguments?: Record<string, unknown>;
}

/** The subset of a session entry we read. */
export interface SessionEntryLike {
	type: string;
	message?: {
		role?: string;
		content?: unknown;
	};
}

/** Pull the text parts out of a message's content (string or block array). */
export function extractTextParts(content: unknown): string[] {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];
	const parts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const block = part as ContentBlock;
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts;
}

/** Render the tool-call blocks of an assistant message as one line each. */
export function extractToolCallLines(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	const lines: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const block = part as ContentBlock;
		if (block.type !== "toolCall" || typeof block.name !== "string") continue;
		lines.push(`Tool ${block.name} was called with args ${JSON.stringify(block.arguments ?? {})}`);
	}
	return lines;
}

/** Default cap on a single tool result's text before it is truncated for the shared-prefix layout. */
export const MAX_TOOL_RESULT_CHARS = 4000;

/**
 * Walk the same message entries `buildConversationText` does, but keep each entry's `message`
 * object (pi `Message` shape) instead of flattening it — the `shared-prefix` judge layout rides the
 * agent's own message array. Tool-result text blocks over `maxToolResultChars` are truncated with a
 * marker so a single large result can't blow up the judge request; every other message is passed
 * through unchanged. Returned loosely typed so this module keeps no dependency on the message types.
 */
export function entriesToMessages(
	entries: SessionEntryLike[],
	maxToolResultChars: number = MAX_TOOL_RESULT_CHARS,
): unknown[] {
	const messages: unknown[] = [];
	for (const entry of entries) {
		const role = entry.type === "message" ? entry.message?.role : undefined;
		if (role === "user" || role === "assistant") {
			messages.push(entry.message);
		} else if (role === "toolResult") {
			messages.push(truncateToolResult(entry.message as { content?: unknown }, maxToolResultChars));
		}
	}
	return messages;
}

/** Clone a tool-result message, truncating any text block longer than `max` with a marker. */
function truncateToolResult(message: { content?: unknown }, max: number): unknown {
	const content = message.content;
	if (!Array.isArray(content)) return message;
	const truncated = content.map((part) => {
		if (!part || typeof part !== "object") return part;
		const block = part as ContentBlock;
		if (block.type === "text" && typeof block.text === "string" && block.text.length > max) {
			const dropped = block.text.length - max;
			return { ...block, text: `${block.text.slice(0, max)}\n…[truncated ${dropped} chars]` };
		}
		return part;
	});
	return { ...message, content: truncated };
}

/** Flatten user/assistant entries (text + tool calls) into one transcript string. */
export function buildConversationText(entries: SessionEntryLike[]): string {
	const sections: string[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || !entry.message?.role) continue;
		const role = entry.message.role;
		const isUser = role === "user";
		const isAssistant = role === "assistant";
		if (!isUser && !isAssistant) continue;

		const lines: string[] = [];
		const textParts = extractTextParts(entry.message.content);
		const text = textParts.join("\n").trim();
		if (text.length > 0) lines.push(`${isUser ? "User" : "Assistant"}: ${text}`);
		if (isAssistant) lines.push(...extractToolCallLines(entry.message.content));
		if (lines.length > 0) sections.push(lines.join("\n"));
	}
	return sections.join("\n\n");
}
