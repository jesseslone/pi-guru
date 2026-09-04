/**
 * The decision pipeline for a change call, in order:
 *   1. hard deny   — deterministic block, overrides everything
 *   2. session allow — a remembered approval passes silently
 *   3. judge       — rate the call (only when judge mode is advise or auto, the design notes);
 *                    auto-approve within the threshold, otherwise carry a verdict to the gate
 *   4. gate        — ask a person (Approve / Deny / …), verdict shown in the header
 *   5. no UI       — block and write a stop handoff when no person is present (with the
 *                    verdict/failure text when the judge ran in auto mode)
 *
 * Kept independent of the pi runtime: the extension entry adapts `tool_call` events
 * into a `NormalizedCall` and injects the side effects (judge, gate, handoff, session entry)
 * so the whole flow is unit-testable with fakes.
 */

import type { SessionAllows } from "./allows.ts";
import type { CommandWords } from "./classify.ts";
import type { GateLevel } from "./gate-level.ts";
import type { GateRequest, GateResult } from "./gate-ui.ts";
import type { HandoffDetails } from "./handoff.ts";
import type { CompiledRule, HardDenyRule } from "./hard-deny.ts";
import { hardDenyBash, hardDenyPath } from "./hard-deny.ts";
import { redactSecrets } from "./redact.ts";

/** The reason returned to the agent when a change call is blocked with no person present. */
export const NO_UI_REASON =
	"pi-guru: no one is here to review this change. Run pi interactively to decide at the gate, or turn on the judge's auto mode to let it approve low-risk changes for you.";

/** A change call normalized for the pipeline. `other` covers unknown/custom change tools. */
export interface NormalizedCall {
	toolName: string;
	kind: "bash" | "write" | "edit" | "other";
	/** Raw command, for bash — also the hard-deny subject. */
	command?: string;
	/** Extracted command words, for bash session-allow matching. */
	words?: CommandWords;
	/** Target path, for write/edit — the hard-deny subject and allow key. */
	filePath?: string;
	/**
	 * The full text being written, for write/edit — the write body, or an edit's joined new text.
	 * Consumed by the deterministic assessor for content and secret facts; unlike
	 * `detail` it is never clipped, so a secret past the preview limit is still scanned.
	 */
	content?: string;
	/** One-line title for the gate, e.g. "Run this command?" */
	title: string;
	/** Detail shown at the gate: the command, or path plus a short preview. */
	detail: string;
}

/** A session entry recorded so decisions sit in scrollback (nothing enters model context). */
export type EntryKind = "hard-deny" | "decision" | "handoff" | "auto-approve" | "standdown";

/**
 * A declared or detected sandbox. When `active`, a launcher has confined this run at
 * the OS level, so pi-guru stands aside — skips the gate and judge, writes no stop handoff — but
 * keeps its deterministic hard denies. `signal` names what fired (`PI_GURU_SANDBOXED=1` or a
 * Linux-container heuristic) for the standdown entry and `/gate`.
 */
export interface SandboxSignal {
	active: boolean;
	signal: string;
}

/**
 * The judge stage, injected by the extension. Runs only when judge mode is advise
 * or auto; it owns the model call, the threshold decision, the session counters and the
 * circuit breaker, and returns either an auto-approval (with the verdict line to record) or a
 * gate instruction carrying the header the gate/handoff should show (a verdict badge or a
 * "judge unavailable" note). The judge never allows on failure, so a failure yields a gate.
 */
export type JudgeStage = (call: NormalizedCall) => Promise<JudgeStageResult>;

export type JudgeStageResult =
	| { kind: "auto-approve"; verdictLine: string }
	| { kind: "gate"; header: string };

export interface EntryData {
	toolName: string;
	detail: string;
	outcome: string;
	reason?: string;
	handoffPath?: string;
	timestamp: number;
}

/** The block result pi expects from a `tool_call` handler; `undefined` means allow. */
export interface BlockResult {
	block: true;
	reason: string;
	terminate?: boolean;
}

export interface PipelineDeps {
	rules: CompiledRule[];
	/** Compiled from config; kept for reference (rules above are already compiled). */
	extraRuleSources?: HardDenyRule[];
	allows: SessionAllows;
	cwd: string;
	hasUI: boolean;
	/** A declared/detected sandbox; when active, pi-guru stands aside. */
	sandbox?: SandboxSignal;
	/** The judge stage; absent when judge mode is off (or advise with no UI — see the entry). */
	judge?: JudgeStage;
	/**
	 * The session gate level is `off`: skip the judge and the gate for change calls and
	 * approve them, recording a `pi-guru:decision` entry with outcome `auto-approved (gate off)`.
	 * Hard denies still run (they precede this). Absent/false at every other level.
	 */
	gateOff?: boolean;
	gate: (req: GateRequest) => Promise<GateResult>;
	/**
	 * Apply a new session gate level chosen at the gate's second menu and return the
	 * deps to re-evaluate the pending call under it — so the re-evaluation runs through the same
	 * pipeline. Returns `null` when the change did not take effect (e.g. an auto level with no
	 * model), so the call re-runs with the current deps and the gate is presented again. Injected
	 * by the extension, which owns the session level; absent in unit tests that never change it.
	 */
	applyGateLevel?: (level: GateLevel) => PipelineDeps | null;
	writeHandoff: (details: HandoffDetails) => string;
	appendEntry: (kind: EntryKind, data: EntryData) => void;
}

/** Run the pipeline for one change call. Returns a block result, or undefined to allow. */
export async function runPipeline(
	call: NormalizedCall,
	deps: PipelineDeps,
): Promise<BlockResult | undefined> {
	const now = Date.now();

	// Hard deny — deterministic tripwire. A bash call matches command rules on its text and path
	// rules on resolved redirection targets; a write/edit call matches path rules on its target
	// path. Computed up front so the sandbox and normal branches share it.
	const denied =
		call.kind === "bash"
			? hardDenyBash(call.command ?? "", deps.rules)
			: call.filePath
				? hardDenyPath(call.filePath, deps.rules)
				: undefined;

	// 0. Sandbox declared. A launcher confined this run at the OS level, so pi-guru
	//    stands aside: skip the gate and the judge, write no stop handoff. Hard denies still
	//    apply — the OS sandbox is not a licence for the few deterministic tripwires — but they
	//    block only the single call (no terminate). One standdown entry names the signal; the
	//    extension records it once per session.
	if (deps.sandbox?.active) {
		if (denied) {
			const reason = `pi-guru hard deny: ${denied}`;
			deps.appendEntry("hard-deny", {
				toolName: call.toolName,
				detail: redactSecrets(call.detail),
				outcome: "hard-denied",
				reason,
				timestamp: now,
			});
			return { block: true, reason };
		}
		deps.appendEntry("standdown", {
			toolName: call.toolName,
			detail: `pi-guru is standing aside: a sandbox launcher declared OS confinement. The gate and judge are off for this run; hard denies still apply.`,
			outcome: "sandboxed",
			reason: `sandbox declared (${deps.sandbox.signal})`,
			timestamp: now,
		});
		return undefined;
	}

	// 1. Hard deny — overrides session allows, judge, everything. It blocks this single call but
	//    does NOT terminate the turn: a false-positive-prone rule must let the
	//    agent explain and try something else. With no person present (and no sandbox declared)
	//    it still leaves a secret-redacted stop handoff so the stop is never silent.
	if (denied) {
		const reason = `pi-guru hard deny: ${denied}`;
		const attempted = redactSecrets(call.detail);
		const handoffPath = deps.hasUI
			? undefined
			: deps.writeHandoff({ toolName: call.toolName, attempted, reason });
		deps.appendEntry("hard-deny", {
			toolName: call.toolName,
			detail: deps.hasUI ? call.detail : attempted,
			outcome: "hard-denied",
			reason,
			handoffPath,
			timestamp: now,
		});
		return { block: true, reason };
	}

	// 1.5. Gate off — the session gate level is `off`: skip the judge and the gate and
	//      approve this change call. Hard denies above still ran; only they remain at this level. A
	//      `pi-guru:decision` entry with outcome `auto-approved (gate off)` keeps scrollback honest
	//      about what ran.
	if (deps.gateOff) {
		deps.appendEntry("decision", {
			toolName: call.toolName,
			detail: call.detail,
			outcome: "auto-approved (gate off)",
			timestamp: now,
		});
		return undefined;
	}

	// 2. Session allow — a remembered approval passes silently.
	if (matchesAllow(call, deps.allows, deps.cwd)) {
		return undefined;
	}

	// 3. Judge — rate the call before the gate. Auto-approval passes silently (recorded in
	//    scrollback); anything else carries a verdict/failure header into the gate or handoff.
	let header: string | undefined;
	if (deps.judge) {
		const verdict = await deps.judge(call);
		if (verdict.kind === "auto-approve") {
			deps.appendEntry("auto-approve", {
				toolName: call.toolName,
				detail: call.detail,
				outcome: "auto-approved",
				reason: verdict.verdictLine,
				timestamp: now,
			});
			return undefined;
		}
		header = verdict.header;
	}

	// 4. No UI, no sandbox declared — an unattended supervised run that cannot proceed: there is
	//    no person to decide at the gate and no launcher-declared confinement to lean on. This is
	//    the one place `terminate: true` survives. Leave a secret-redacted stop handoff
	//    so the stop is never silent; when the judge ran (auto mode) its verdict/failure rides
	//    along so the note says why.
	if (!deps.hasUI) {
		const reason = header ? `${NO_UI_REASON}\n\n${header}` : NO_UI_REASON;
		const attempted = redactSecrets(call.detail);
		const handoffPath = deps.writeHandoff({
			toolName: call.toolName,
			attempted,
			reason,
		});
		deps.appendEntry("handoff", {
			toolName: call.toolName,
			detail: attempted,
			outcome: "handoff",
			reason,
			handoffPath,
			timestamp: now,
		});
		return { block: true, reason, terminate: true };
	}

	// 5. Gate — ask a person, showing the judge's verdict in the header when present.
	const result = await deps.gate({ title: call.title, detail: call.detail, header });
	// The person changed the session gate level from the second menu: apply it and
	// re-evaluate this same call under the new level through the pipeline — an auto level judges it,
	// off approves it. A `null` from `applyGateLevel` (the change did not take effect) re-runs under
	// the current deps, presenting the gate again.
	if (result.decision === "change-level") {
		const nextDeps = deps.applyGateLevel?.(result.level) ?? null;
		return runPipeline(call, nextDeps ?? deps);
	}
	if (result.decision === "deny") {
		deps.appendEntry("decision", {
			toolName: call.toolName,
			detail: call.detail,
			outcome: "denied",
			reason: result.reason,
			timestamp: now,
		});
		return { block: true, reason: result.reason };
	}
	if (result.decision === "approve-session") {
		remember(call, deps.allows, deps.cwd);
		deps.appendEntry("decision", {
			toolName: call.toolName,
			detail: call.detail,
			outcome: "approved-session",
			timestamp: now,
		});
		return undefined;
	}
	deps.appendEntry("decision", {
		toolName: call.toolName,
		detail: call.detail,
		outcome: "approved",
		timestamp: now,
	});
	return undefined;
}

function matchesAllow(call: NormalizedCall, allows: SessionAllows, cwd: string): boolean {
	if (call.kind === "bash" && call.words) return allows.matchesBash(call.words);
	if ((call.kind === "write" || call.kind === "edit") && call.filePath)
		return allows.matchesPath(call.filePath, cwd);
	return false;
}

function remember(call: NormalizedCall, allows: SessionAllows, cwd: string): void {
	if (call.kind === "bash" && call.words) allows.allowBash(call.words);
	else if ((call.kind === "write" || call.kind === "edit") && call.filePath)
		allows.allowPathDir(call.filePath, cwd);
}
