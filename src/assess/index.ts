/**
 * The deterministic risk assessor entry point.
 *
 * `assess` runs a static pass over one pending change call and returns neutral **facts**, the
 * strongest deterministic **floor** any fact imposes, and whether the command resolved to literal
 * words. Bash facts come from the unbash AST (`bash.ts`); write/edit facts from the resolved target
 * path plus a content scan (`content.ts`) and an in-process secret table (`secrets.ts`). Nothing here
 * spawns a process or calls a model — the whole pass is under the 10 ms budget in
 * `docs/research/risk-assessors.md`.
 */

import type { NormalizedCall } from "../pipeline.ts";
import { assessBash } from "./bash.ts";
import { assessContent } from "./content.ts";
import { strongestFloor } from "./floors.ts";
import { isCredentialPath, isSystemPath, resolvePath } from "./paths.ts";
import { scanSecrets } from "./secrets.ts";
import type { AssessContext, AssessResult, Fact, Floor } from "./types.ts";

export { strongestFloor } from "./floors.ts";
export type { AssessContext, AssessResult, Fact, Floor, Severity } from "./types.ts";

/**
 * A floor decision ready to apply to a verdict: the minimum risk, the fact id, and a human reason.
 * Structurally the `AppliedFloor` `judge.applyFloor` consumes, so the assessor need not import the
 * judge. The reason names the fact and, when the evidence is a path, appends it.
 */
export interface FloorDecision {
	floor: Floor;
	factId: string;
	reason: string;
}

/** Assess one pending change call into facts, an optional floor, and a resolution flag. */
export function assess(call: NormalizedCall, ctx: AssessContext): AssessResult {
	const { facts, unresolved } = collect(call, ctx);
	const floor = strongestFloor(facts)?.floor;
	return { facts, floor, unresolved };
}

/**
 * Render the facts block placed OUTSIDE the untrusted fence in the judge/Explain request:
 * a "Facts pi-guru verified about this action:" list, plus a "could not fully parse" note when the
 * command was unresolved. Returns undefined when there is nothing to say.
 *
 * The block is trusted (pi-guru computed it), so a fact's *evidence* — which is derived from the
 * untrusted command (a resolved path, a flag) — is sanitised (control chars stripped, one line, capped)
 * before it lands here, so a crafted filename cannot inject a new instruction line into the trusted
 * region. The fact `text` is pi-guru's own constant and is safe.
 */
export function renderFactsBlock(facts: Fact[], unresolved: boolean): string | undefined {
	const real = facts.filter((f) => f.id !== "unresolved");
	const lines: string[] = [];
	if (real.length > 0) {
		lines.push("Facts pi-guru verified about this action:");
		for (const f of real) {
			const evidence = sanitizeEvidence(f.evidence);
			lines.push(evidence && !f.text.includes(evidence) ? `- ${f.text} — ${evidence}` : `- ${f.text}`);
		}
	}
	if (unresolved) {
		lines.push(
			real.length > 0
				? "pi-guru could not fully parse this command, so the facts above may be incomplete."
				: "pi-guru could not fully parse this command (a substitution or an unlisted wrapper).",
		);
	}
	return lines.length > 0 ? lines.join("\n") : undefined;
}

/** Strip control chars, flatten to one line, and cap — so untrusted-derived evidence cannot inject. */
function sanitizeEvidence(evidence: string): string {
	let out = "";
	for (const ch of evidence) {
		const code = ch.codePointAt(0) ?? 0;
		out += code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? " " : ch;
	}
	const flattened = out.replace(/\s+/g, " ").trim();
	return flattened.length > 200 ? `${flattened.slice(0, 200)}…` : flattened;
}

/** The floor decision for an assessment's facts, or undefined when nothing floors. */
export function floorDecision(facts: Fact[]): FloorDecision | undefined {
	const strongest = strongestFloor(facts);
	if (!strongest) return undefined;
	const { floor, fact } = strongest;
	const reason = fact.evidence.includes("/") ? `${fact.text} (${fact.evidence})` : fact.text;
	return { floor, factId: fact.id, reason };
}

/** Dispatch by call kind, returning the raw facts and whether the command fully resolved. */
function collect(call: NormalizedCall, ctx: AssessContext): { facts: Fact[]; unresolved: boolean } {
	if (call.kind === "bash") {
		return assessBash(call.command ?? "", ctx);
	}
	if (call.kind === "write" || call.kind === "edit") {
		return { facts: assessWrite(call, ctx), unresolved: false };
	}
	// An unknown/foreign tool: pi-guru cannot see inside it, so it has no deterministic facts.
	return { facts: [], unresolved: false };
}

/** Write/edit facts: the resolved target path, then the content and secret scan. */
function assessWrite(call: NormalizedCall, ctx: AssessContext): Fact[] {
	const facts: Fact[] = [];
	if (call.filePath) {
		const abs = resolvePath(call.filePath, ctx);
		if (abs && isSystemPath(abs, ctx.home)) {
			facts.push({
				id: "writes-system-path",
				text: "writes under a system path",
				severity: "medium",
				evidence: abs,
			});
		} else if (abs && isCredentialPath(abs, ctx.home)) {
			facts.push({
				id: "writes-credential-path",
				text: "writes to a credential or key location",
				severity: "medium",
				evidence: abs,
			});
		}
	}
	const content = call.content ?? "";
	if (call.filePath) facts.push(...assessContent(call.filePath, content, ctx));
	for (const match of scanSecrets(content)) {
		facts.push({
			id: `secret-${match.id}`,
			text: `writes ${match.label} into the file`,
			severity: "high",
			evidence: match.label,
		});
	}
	return dedupe(facts);
}

function dedupe(facts: Fact[]): Fact[] {
	const seen = new Set<string>();
	const out: Fact[] = [];
	for (const f of facts) {
		const key = `${f.id} ${f.evidence}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(f);
	}
	return out;
}
