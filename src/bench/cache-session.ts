/**
 * The fixed synthetic session the cache benchmark replays.
 *
 * The cache advantage of `prefix-stable` and `shared-prefix` is a *within-session, growing-transcript*
 * property (plan finding 1): call n+1 reuses call n's KV blocks only when the transcript prefix is
 * identical and merely grows. So the cache benchmark cannot use independent records like the accuracy
 * runner — it needs ONE ordered session replayed as a single appended transcript. This module builds
 * that session from our own hand-written cases (`bench/cases`, MIT), so nothing third-party is
 * replayed: a leading user turn, then one step per change call, each step judged against a transcript
 * that contains every earlier call's assistant text and executed tool call. Because steps only ever
 * append, step n's transcript is a byte-prefix of step n+1's — exactly the shape the layouts exploit.
 */

import type { JudgeSubject } from "../judge.ts";
import type { Context } from "../model.ts";
import { buildConversationText, entriesToMessages, type SessionEntryLike } from "../transcript.ts";
import { assessRecord } from "./assess-record.ts";
import { type TranscriptTurn, toEntries } from "./entries.ts";
import type { BenchRecord } from "./schema.ts";

/** One judged step of the synthetic session: the pending call plus the transcript so far. */
export interface JudgeStep {
	/** 1-based position in the session. */
	call: number;
	/** The change call to rate at this step (the record's production `pending`). */
	subject: JudgeSubject;
	/** The flattened conversation before this call — grows monotonically across steps. */
	transcript: string;
	/** The same conversation as pi `Message`s, for the `shared-prefix` layout — also monotonic. */
	agentMessages: Context["messages"];
	/** The record's authored risk, when present — used only for verdict-agreement context. */
	authoredRisk?: string;
	/** The deterministic facts block for this call, sent when the run has `--facts on`. */
	factsBlock?: string;
}

/** The synthetic session: a fixed agent system prompt (ours) and the ordered steps. */
export interface SyntheticSession {
	agentSystemPrompt: string;
	steps: JudgeStep[];
}

/** Our own synthetic agent system prompt for the `shared-prefix` layout — never a real agent's. */
export const SYNTHETIC_AGENT_SYSTEM_PROMPT = [
	"You are a coding assistant helping harden and clean up a software project.",
	"Work through the user's tasks one at a time, using tools to make each change.",
	"Explain what you are about to do before each tool call.",
].join("\n");

/** The opening user turn that frames the session. */
const OPENING_USER_TURN =
	"Work through these cleanup and hardening tasks one at a time. I'll review each change before it runs.";

/** Options for `buildSyntheticSession`. `padTokens` grows the early transcript (the design notes item 3). */
export interface SessionOptions {
	/** Pad the session's early transcript with deterministic filler up to ~N tokens (4 chars/token). */
	padTokens?: number;
	/** Seed for the filler PRNG, so a padded session is byte-identical across runs and machines. */
	seed?: number;
}

/** Estimate a text's token count at the plan's 4-chars-per-token proxy. */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/** A small deterministic PRNG (mulberry32) so filler is seeded, not random. */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Plausible coding-assistant narration fragments — banks the filler PRNG draws from, not lorem ipsum. */
const FILLER_ACTIONS = [
	"Scanning the module for unused imports before I touch anything",
	"Reading the failing test to see which assertion trips",
	"Grepping for other call sites so the rename stays consistent",
	"Checking the lockfile to confirm the pinned version",
	"Inspecting the config loader for the default it falls back to",
	"Tracing where the error is swallowed so it surfaces properly",
	"Reviewing the diff once more for stray debug logging",
	"Verifying the fixture matches the shape the parser expects",
];
const FILLER_TOOLS = ["read", "grep", "list", "bash"];
const FILLER_TOOL_DETAIL = [
	"src/config.ts",
	"src/parser/index.ts",
	"test/fixtures/sample.json",
	"packages/core/src/util.ts",
	"scripts/build.mjs",
	"docs/reference/api.md",
];
const FILLER_ACKS = [
	"Looks right — go ahead.",
	"Good, continue to the next one.",
	"That matches what I expected; proceed.",
	"Fine. Keep going carefully.",
];

/**
 * Deterministic filler turns that pad the early transcript to ~`padTokens` tokens (the design notes item 3).
 * Draws plausible assistant narration + a tool call, then a short user ack, from fixed banks under a
 * seeded PRNG — never lorem ipsum, so a reader (or the judge) sees a realistic early session. Returns
 * an empty array when `padTokens` is not positive.
 */
export function fillerTurns(padTokens: number, seed = 1): TranscriptTurn[] {
	if (!padTokens || padTokens <= 0) return [];
	const rng = mulberry32(seed);
	const pick = <T>(bank: T[]): T => bank[Math.floor(rng() * bank.length)];
	const target = padTokens * 4; // chars
	const turns: TranscriptTurn[] = [];
	// Measure against the flattened transcript so the estimate matches what the judge actually sees.
	const flattenedChars = () =>
		buildConversationText(toEntries(turns) as unknown as SessionEntryLike[]).length;
	let step = 0;
	while (flattenedChars() < target) {
		step += 1;
		const detail = pick(FILLER_TOOL_DETAIL);
		turns.push({
			role: "assistant",
			text: `${pick(FILLER_ACTIONS)} (step ${step}).`,
			toolCalls: [{ name: pick(FILLER_TOOLS), arguments: { path: detail, note: pick(FILLER_ACTIONS) } }],
		});
		turns.push({ role: "user", text: pick(FILLER_ACKS) });
	}
	return turns;
}

/** First line of a possibly multi-line string, for the assistant's narration turn. */
function firstLine(text: string): string {
	const nl = text.indexOf("\n");
	return nl === -1 ? text : text.slice(0, nl);
}

/**
 * Build the synthetic growing session from ordered bench records (deterministic: the caller passes a
 * stable order, e.g. hand-written cases sorted by id). Takes the first `count` records. Each record
 * contributes one judged step, then its narration + tool call are appended so the next step's
 * transcript strictly extends this one.
 */
export function buildSyntheticSession(
	records: BenchRecord[],
	count: number,
	opts: SessionOptions = {},
): SyntheticSession {
	const chosen = records.slice(0, Math.max(1, count));
	// The opening user turn, then deterministic filler (padding the early transcript), then the judged
	// steps. Filler sits at the front and is fixed, so the stable layouts still see a growing prefix.
	const turns: TranscriptTurn[] = [
		{ role: "user", text: OPENING_USER_TURN },
		...fillerTurns(opts.padTokens ?? 0, opts.seed ?? 1),
	];
	const steps: JudgeStep[] = [];

	chosen.forEach((record, i) => {
		const entries = toEntries(turns) as unknown as SessionEntryLike[];
		steps.push({
			call: i + 1,
			subject: { title: record.pending.title, detail: record.pending.detail },
			transcript: buildConversationText(entries),
			agentMessages: entriesToMessages(entries) as Context["messages"],
			authoredRisk: record.authoredRisk,
			// Precomputed once; the cache runner sends it only when the run has `--facts on`.
			factsBlock: assessRecord(record.kind, record.pending.detail).factsBlock,
		});
		// Append this call's narration and the tool call it makes, so the next step sees them.
		turns.push({
			role: "assistant",
			text: `Task ${i + 1}: ${record.pending.title} ${firstLine(record.pending.detail)}`,
			toolCalls: [{ name: record.kind, arguments: { detail: record.pending.detail } }],
		});
	});

	return { agentSystemPrompt: SYNTHETIC_AGENT_SYSTEM_PROMPT, steps };
}
