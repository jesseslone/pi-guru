/**
 * Run the deterministic assessor over a benchmark record, so `--facts on` runs measure
 * the effect of pi-guru's facts block + floors on the judge.
 *
 * A record keeps only its production `pending` = `{title, detail}`, so the structured call is
 * reconstructed from `kind` + `detail`: for bash the detail *is* the command; for write/edit the
 * detail is `path\n\n<preview>`, split back into a path and content. The reconstruction is lossy for
 * write/edit content (production clips the preview at 400 chars), but the resolved-path facts — the
 * ones that floor — are exact, and the corpora that matter (RedCode, rogue-security) are bash. A
 * fixed synthetic context resolves `~`/relative paths, since a bench record has no real cwd.
 */

import { assess, type FloorDecision, floorDecision, renderFactsBlock } from "../assess/index.ts";
import type { NormalizedCall } from "../pipeline.ts";
import type { BenchKind } from "./schema.ts";

/** The fixed context the bench resolves paths against — a container-style root, matching the corpora. */
export const BENCH_ASSESS_CTX = { cwd: "/workspace", home: "/root" };

/** Rebuild a NormalizedCall from a record's kind and production detail (see the module note). */
export function reconstructCall(kind: BenchKind, detail: string): NormalizedCall {
	if (kind === "bash") {
		return { toolName: "bash", kind: "bash", command: detail, title: "", detail };
	}
	if (kind === "write" || kind === "edit") {
		const idx = detail.indexOf("\n\n");
		const filePath = idx >= 0 ? detail.slice(0, idx) : detail;
		const content = idx >= 0 ? detail.slice(idx + 2) : "";
		return { toolName: kind, kind, filePath, content, title: "", detail };
	}
	return { toolName: "other", kind: "other", title: "", detail };
}

/** The assessor's output for a record: the facts block (for the prompt) and the floor (for the verdict). */
export interface RecordAssessment {
	factsBlock: string | undefined;
	floor: FloorDecision | undefined;
}

/** Assess one record's pending action into a facts block and a floor decision. */
export function assessRecord(kind: BenchKind, detail: string): RecordAssessment {
	const call = reconstructCall(kind, detail);
	const { facts, unresolved } = assess(call, BENCH_ASSESS_CTX);
	return { factsBlock: renderFactsBlock(facts, unresolved), floor: floorDecision(facts) };
}
