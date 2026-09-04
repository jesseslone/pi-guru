/**
 * The session **gate level** (CONTEXT.md, the design notes): how much pi-guru asks during this
 * session only — `ask` (default), `auto-low`, `auto-medium`, or `off`. It is a runtime-only
 * override, never written to config, and it resets when the session ends.
 *
 * This module is pure: it maps a gate level onto the existing pipeline knobs
 * (`judgeMode` / `judgeThreshold` / a gate-off flag), applying a project config's tighten-only
 * cap. The extension holds the one mutable `gateLevel` per session and wires the result in.
 */

import type { JudgeMode, Threshold } from "./judge.ts";

/** How much pi-guru asks during this session only (CONTEXT.md). */
export type GateLevel = "ask" | "auto-low" | "auto-medium" | "off";

/** Every gate level, in ascending autonomy — for command validation and cap laddering. */
export const ALL_GATE_LEVELS: readonly GateLevel[] = ["ask", "auto-low", "auto-medium", "off"];

/** Narrow an arbitrary value to a GateLevel. */
export function isGateLevel(v: unknown): v is GateLevel {
	return typeof v === "string" && (ALL_GATE_LEVELS as readonly string[]).includes(v);
}

/** Ascending autonomy: ask < auto-low < auto-medium < off. Used to cap by project config. */
const LEVEL_ORDER: Record<GateLevel, number> = { ask: 0, "auto-low": 1, "auto-medium": 2, off: 3 };

/** The judge fields the resolver reads from a config — the merged global/project effective config. */
export interface JudgeConfigView {
	judgeMode: JudgeMode;
	judgeThreshold: Threshold;
}

/** The judge fields a project config may set (both optional; present ⇒ it participates in the cap). */
export interface ProjectJudgeView {
	judgeMode?: JudgeMode;
	judgeThreshold?: Threshold;
}

/** The runtime knobs a gate level maps to, plus the applied level after the project cap. */
export interface SessionJudge {
	/** The judge mode the pipeline runs with this call (before the circuit-breaker drop). */
	mode: JudgeMode;
	/** The autonomy threshold the pipeline runs with this call. */
	threshold: Threshold;
	/** When true, skip the judge and the gate for change calls (the `off` level). */
	gateOff: boolean;
	/** The requested level after the project cap — what actually took effect. */
	appliedLevel: GateLevel;
	/** True when the project cap lowered the requested level. */
	capped: boolean;
}

/**
 * The highest gate level a project config permits under the tighten-only rule. A project that
 * forbids auto (its `judgeMode` is set to a non-`auto` value) caps the session at `ask`; a
 * project that lowers the threshold to `low` caps it at `auto-low` (auto-medium and off are more
 * autonomous). Otherwise there is no cap.
 */
function projectMaxLevel(project?: ProjectJudgeView): GateLevel {
	if (!project) return "off";
	if (project.judgeMode !== undefined && project.judgeMode !== "auto") return "ask";
	if (project.judgeThreshold === "low") return "auto-low";
	return "off";
}

/** Lower `requested` to the project's maximum permitted level when it exceeds it. */
function capLevel(requested: GateLevel, project?: ProjectJudgeView): GateLevel {
	const max = projectMaxLevel(project);
	return LEVEL_ORDER[requested] <= LEVEL_ORDER[max] ? requested : max;
}

/**
 * Resolve a requested gate level to the runtime judge knobs, applying the project's tighten-only
 * cap. At `ask` the config's own judge mode/threshold stand — so the default is
 * byte-identical to a build without this feature. `auto-*` forces auto with that threshold even
 * when config says advise/off; `off` sets `gateOff`. The global config never caps the override —
 * only the project config does, and `capped` records when it did so the caller can say so.
 */
export function resolveSessionJudge(
	requested: GateLevel,
	config: JudgeConfigView,
	project?: ProjectJudgeView,
): SessionJudge {
	const appliedLevel = capLevel(requested, project);
	const capped = appliedLevel !== requested;
	switch (appliedLevel) {
		case "ask":
			return {
				mode: config.judgeMode,
				threshold: config.judgeThreshold,
				gateOff: false,
				appliedLevel,
				capped,
			};
		case "off":
			return { mode: "off", threshold: config.judgeThreshold, gateOff: true, appliedLevel, capped };
		default:
			return {
				mode: "auto",
				threshold: appliedLevel === "auto-medium" ? "medium" : "low",
				gateOff: false,
				appliedLevel,
				capped,
			};
	}
}
