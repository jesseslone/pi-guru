/**
 * Run one record through the production judge path.
 *
 * This is the single wiring the CI smoke test exercises with a fake `Completer`: a record's
 * transcript is flattened by the production `buildConversationText` and its pending action plus the
 * flattened transcript go through the production `runJudge` (which builds the messages with
 * `buildJudgeMessages`, calls the model, and parses with `parseVerdict`). So a schema or wiring
 * regression — a record shape the flattener or judge no longer accepts — fails a test with no model
 * in the loop. Nothing here re-implements the prompt, the message layout, or the parser.
 */

import {
	applyFloor,
	type JudgeLayout,
	type JudgeOutcome,
	type LayoutContext,
	type RiskLevel,
	runJudge,
} from "../judge.ts";
import type { JudgePromptVersion } from "../judge-prompt.ts";
import type { ExplanationLevel } from "../levels.ts";
import type { Completer } from "../model.ts";
import { buildConversationText, type SessionEntryLike } from "../transcript.ts";
import { assessRecord } from "./assess-record.ts";
import type { BenchKind, BenchRecord, Expected } from "./schema.ts";

/** The floor a record's facts imposed (`null` = none), for report counts. */
export type RecordFloor = "medium" | "high" | null;

/** The flat result of judging one record — enough for accuracy scoring and the smoke assertions. */
export interface RecordResult {
	id: string;
	source: string;
	expected: Expected;
	kind: BenchKind;
	available: boolean;
	/** The recorded risk — the model's, raised by a deterministic floor when `--facts on`. */
	risk: RiskLevel | null;
	rationale: string | null;
	reason: string | null;
	/** The model's raw reply on an unparseable verdict, so the cause can be diagnosed. */
	raw: string | null;
	/** The deterministic floor the facts imposed (regardless of the model verdict), or null. */
	floor: RecordFloor;
	/** True when the floor actually raised the model's verdict (`--facts on` only, the design notes). */
	raised: boolean;
}

/**
 * Judge one record with an injected completer (real or fake). Never throws — mirrors production.
 * `layout`/`layoutCtx` thread the request layout through exactly as production and the cache
 * benchmark do; they default so every existing caller stays byte-identical (the design notes item 2).
 *
 * `facts`: when true the deterministic assessor runs over the record's pending call — its
 * facts block is sent to the judge OUTSIDE the fence, and its floor is applied to the verdict
 * (`max(verdict, floor)`), exactly as production does. The recorded `risk` is therefore the *floored*
 * risk, so `--facts on/off` runs measure the real let-through/benign-blocked effect. When false, the
 * path is byte-identical to before (no facts, no floor).
 */
export async function judgeRecord(
	record: BenchRecord,
	complete: Completer,
	level: ExplanationLevel = "technical",
	layout: JudgeLayout = "current",
	layoutCtx: LayoutContext = {},
	promptVersion: JudgePromptVersion = "v1",
	facts = false,
): Promise<RecordResult> {
	const transcript = buildConversationText(record.transcriptEntries as unknown as SessionEntryLike[]);
	const assessment = facts
		? assessRecord(record.kind, record.pending.detail)
		: { factsBlock: undefined, floor: undefined };
	const raw: JudgeOutcome = await runJudge({
		level,
		subject: record.pending,
		transcript,
		complete,
		layout,
		layoutCtx,
		promptVersion,
		factsBlock: assessment.factsBlock,
	});
	const outcome: JudgeOutcome = raw.available
		? { ...raw, verdict: applyFloor(raw.verdict, assessment.floor) }
		: raw;
	return {
		id: record.id,
		source: record.source,
		expected: record.expected,
		kind: record.kind,
		available: outcome.available,
		risk: outcome.available ? outcome.verdict.risk : null,
		rationale: outcome.available ? outcome.verdict.rationale : null,
		reason: outcome.available ? null : outcome.reason,
		raw: outcome.available ? null : (outcome.raw ?? null),
		floor: assessment.floor?.floor ?? null,
		raised: outcome.available ? outcome.verdict.flooredBy !== undefined : false,
	};
}
