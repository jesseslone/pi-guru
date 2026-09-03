/**
 * Explain: the plain-language account of a pending change call the session model gives on
 * request from the gate (CONTEXT.md, the design notes).
 *
 * The first Explain press explains at the configured level; each further press steps one
 * level deeper (fundamental → intermediate → technical; technical repeats). The model call
 * is injected as a `Completer` so this whole flow is unit-testable without a real model.
 * An explanation never enters model context; its token usage is reported to the caller so
 * the gate can record it in a session entry.
 */

import { fenceUntrusted } from "./fence.ts";
import { deeper, EXPLAIN_PROMPTS, type SpokenLevel } from "./levels.ts";
import { type Completer, completionText, type Usage, userMessage } from "./model.ts";

/** What the gate shows the person about the pending call — its title and detail. */
export interface ExplainSubject {
	title: string;
	detail: string;
}

/** One Explain press: a rendered explanation, or a reason it could not be produced. */
export type ExplainStep =
	| { ok: true; level: SpokenLevel; markdown: string; usage: Usage }
	| { ok: false; message: string };

export interface ExplainerDeps {
	/** The configured level; the first explanation is given at this depth. Not `off`. */
	startLevel: SpokenLevel;
	/** The pending change call being explained. */
	subject: ExplainSubject;
	/** The flattened conversation, for context on why this call is being made. */
	transcript: string;
	/** The session-model call. */
	complete: Completer;
	/**
	 * The deterministic assessor's facts block, placed OUTSIDE the untrusted fence so the
	 * explanation can mention what pi-guru verified. Trusted (pi-guru computed it); undefined when off.
	 */
	factsBlock?: string;
	/** Called after each successful step so the caller can record usage in an entry. */
	onStep?: (step: Extract<ExplainStep, { ok: true }>) => void;
}

/** Build the user message handed to the model alongside the level's system prompt. */
export function buildExplainMessages(subject: ExplainSubject, transcript: string, factsBlock?: string) {
	const fenced = fenceUntrusted(
		"Explain the pending action described below to the person supervising the assistant.",
		[
			{ label: "pending action", content: `${subject.title}\n${subject.detail}` },
			{ label: "conversation so far", content: transcript || "(no conversation yet)" },
		],
	);
	// The facts block is pi-guru's own verified context, outside the fence; the explanation may cite it.
	const text = factsBlock
		? `${factsBlock}\n\nMention any of the above facts that bear on what this action does.\n\n${fenced}`
		: fenced;
	return userMessage(text);
}

/**
 * A stepping explainer. Each call returns the next explanation, one level deeper than the
 * last (the first call uses `startLevel`). On a model failure it returns `{ ok: false }`
 * and does *not* advance, so the next press retries the same level.
 */
export function makeExplainer(deps: ExplainerDeps): () => Promise<ExplainStep> {
	let current: SpokenLevel | null = null;
	return async () => {
		const level = current === null ? deps.startLevel : deeper(current);
		try {
			const response = await deps.complete({
				systemPrompt: EXPLAIN_PROMPTS[level],
				messages: buildExplainMessages(deps.subject, deps.transcript, deps.factsBlock),
			});
			const markdown = completionText(response);
			current = level; // advance only on success
			const step = { ok: true as const, level, markdown, usage: response.usage };
			deps.onStep?.(step);
			return step;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return { ok: false, message };
		}
	};
}
