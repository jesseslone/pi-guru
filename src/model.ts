/**
 * Shared helpers for the session-model calls Explain and narration make.
 *
 * pi-guru always speaks through the **session model** (`ctx.model`) via
 * `ctx.modelRegistry.complete` — never a hard-coded provider or model. The
 * `Completer` type is that call reduced to what the pure Explain / narration logic needs,
 * so it can be faked in tests without a real model.
 */

import type { AssistantMessage, Context, Usage } from "@earendil-works/pi-ai";

export type { AssistantMessage, Context, Usage };

/** A model call reduced to a context in, an assistant message out. Faked in tests. */
export type Completer = (context: Context) => Promise<AssistantMessage>;

/** Join the text blocks of an assistant message into a single string. */
export function completionText(message: AssistantMessage): string {
	return message.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n")
		.trim();
}

/** Wrap plain text as the single user message of a `Context`. */
export function userMessage(text: string): Context["messages"] {
	return [{ role: "user", content: [{ type: "text", text }], timestamp: Date.now() }];
}

/** Total tokens billed by a completion, for the entry that records a call's cost. */
export function totalTokens(usage: Usage | undefined): number {
	return usage?.totalTokens ?? 0;
}
