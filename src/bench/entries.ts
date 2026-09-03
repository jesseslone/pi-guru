/**
 * Build a transcript as pi `SessionEntry[]` from terse turns.
 *
 * A benchmark record carries the conversation so far in pi's real session-entry shape, so the
 * runner flattens it with the production `buildConversationText` (`src/transcript.ts`) exactly as
 * the gate does. The flattener reads only `entry.type`, `message.role`, and `message.content`, so
 * a user turn is a fully-valid `UserMessage` entry; an assistant tool-call turn needs the heavy
 * provider fields of `AssistantMessage` (`api`/`provider`/`model`/`usage`/`stopReason`) that never
 * affect flattening — those are filled with inert placeholders and the entry is cast once here.
 *
 * Ids, parent chaining, and timestamps are deterministic (a fixed base time), so a record's
 * transcript is byte-stable across runs and machines.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/** One terse transcript turn a converter emits. */
export type TranscriptTurn =
	| { role: "user"; text: string }
	| {
			role: "assistant";
			text?: string;
			toolCalls?: { name: string; arguments: Record<string, unknown> }[];
	  };

/** Fixed base time so transcript timestamps are deterministic, not `Date.now()`. */
const BASE_TIME = Date.UTC(2020, 0, 1);

/** Assemble terse turns into a parent-linked chain of pi `SessionEntry` message entries. */
export function toEntries(turns: TranscriptTurn[]): SessionEntry[] {
	const entries: SessionEntry[] = [];
	let parentId: string | null = null;
	turns.forEach((turn, i) => {
		const id = `bench-e${i}`;
		const timestamp = new Date(BASE_TIME + i * 1000).toISOString();
		const message =
			turn.role === "user"
				? {
						role: "user" as const,
						content: [{ type: "text" as const, text: turn.text }],
						timestamp: BASE_TIME + i * 1000,
					}
				: assistantMessage(turn, BASE_TIME + i * 1000);
		// The message entry is a genuine `SessionMessageEntry`; the assistant placeholder provider
		// fields are inert (never sent to a model — the transcript is only flattened), so the one
		// cast here is confined to this builder.
		entries.push({ type: "message", id, parentId, timestamp, message } as unknown as SessionEntry);
		parentId = id;
	});
	return entries;
}

/** Build the `AssistantMessage` body for an assistant turn, with inert placeholder provider fields. */
function assistantMessage(
	turn: { text?: string; toolCalls?: { name: string; arguments: Record<string, unknown> }[] },
	timestamp: number,
) {
	const content: unknown[] = [];
	if (turn.text) content.push({ type: "text", text: turn.text });
	for (const [i, call] of (turn.toolCalls ?? []).entries()) {
		content.push({ type: "toolCall", id: `bench-tc${i}`, name: call.name, arguments: call.arguments });
	}
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "bench",
		model: "bench",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp,
	};
}
