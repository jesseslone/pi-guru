/**
 * pi-guru configuration: a global file `~/.pi/agent/pi-guru.json` and an optional
 * project file `.pi/pi-guru.json` that may only *tighten* the global policy — add hard
 * denies or remove read-only tools, never loosen.
 *
 * Slice-1 fields: `readOnlyTools: string[]`, `hardDeny: string[]` (regex source strings
 * appended to the seed hard-deny list). Slice 2 adds `level` — the persisted explanation
 * level. The level is a person's preference, not a safety setting, so a project
 * config may *not* change it (unlike the tighten-only policy fields).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { JudgeLayout, JudgeMode, Threshold } from "./judge.ts";
import {
	DEFAULT_JUDGE_PROMPT_VERSION,
	isJudgePromptVersion,
	type JudgePromptVersion,
} from "./judge-prompt.ts";
import { DEFAULT_LEVEL, type ExplanationLevel, isExplanationLevel } from "./levels.ts";

export interface PiGuruConfig {
	readOnlyTools: string[];
	hardDeny: string[];
	level: ExplanationLevel;
	/** Judge mode: off (default), advise, or auto. */
	judgeMode: JudgeMode;
	/** In auto mode, the highest risk the judge may approve on the person's behalf. */
	judgeThreshold: Threshold;
	/**
	 * The judge request layout (slice 3). Defaults to `current`; the benchmark measures the
	 * alternatives. Like `level`, this is not a policy a repo may set, so a project config may not
	 * change it — the global value always stands.
	 */
	judgeLayout: JudgeLayout;
	/**
	 * The judge prompt version. Defaults to `v1`, the shipping text. Like `level` and
	 * `judgeLayout`, this is not a policy a repo may set, so a project config may not change it — the
	 * global value always stands.
	 */
	judgePrompt: JudgePromptVersion;
	/**
	 * Whether the deterministic assessor's facts block is sent to the judge and Explain.
	 * Defaults to on. Like `level`/`judgeLayout`/`judgePrompt` it is not a repo policy — a project
	 * config may not change it, so the global value always stands.
	 */
	judgeFacts: boolean;
}

/** The parsed shape of a config file; every field optional. */
interface RawConfig {
	readOnlyTools?: unknown;
	hardDeny?: unknown;
	level?: unknown;
	judgeMode?: unknown;
	judgeThreshold?: unknown;
	judgeLayout?: unknown;
	judgePrompt?: unknown;
	judgeFacts?: unknown;
}

/** Judge defaults for a fresh install: off, and — if ever enabled — the safest threshold. */
export const DEFAULT_JUDGE_MODE: JudgeMode = "advise";
export const DEFAULT_JUDGE_THRESHOLD: Threshold = "low";
/** The layout production has always sent; the alternatives are a benchmark opt-in. */
export const DEFAULT_JUDGE_LAYOUT: JudgeLayout = "current";
/** The judge prompt version production sends unless config names another. */
export const DEFAULT_JUDGE_PROMPT: JudgePromptVersion = DEFAULT_JUDGE_PROMPT_VERSION;
/** The deterministic facts block is on by default. */
export const DEFAULT_JUDGE_FACTS = true;

const EMPTY: PiGuruConfig = {
	readOnlyTools: [],
	hardDeny: [],
	level: DEFAULT_LEVEL,
	judgeMode: DEFAULT_JUDGE_MODE,
	judgeThreshold: DEFAULT_JUDGE_THRESHOLD,
	judgeLayout: DEFAULT_JUDGE_LAYOUT,
	judgePrompt: DEFAULT_JUDGE_PROMPT,
	judgeFacts: DEFAULT_JUDGE_FACTS,
};

function isJudgeMode(v: unknown): v is JudgeMode {
	return v === "off" || v === "advise" || v === "auto";
}

function isThreshold(v: unknown): v is Threshold {
	return v === "low" || v === "medium";
}

function isJudgeLayout(v: unknown): v is JudgeLayout {
	return v === "current" || v === "prefix-stable" || v === "shared-prefix";
}

/** Coerce arbitrary JSON into a config, ignoring anything malformed. */
export function parseConfig(raw: unknown): PiGuruConfig {
	const r = (raw ?? {}) as RawConfig;
	return {
		readOnlyTools: asStringArray(r.readOnlyTools),
		hardDeny: asStringArray(r.hardDeny),
		level: isExplanationLevel(r.level) ? r.level : DEFAULT_LEVEL,
		judgeMode: isJudgeMode(r.judgeMode) ? r.judgeMode : DEFAULT_JUDGE_MODE,
		judgeThreshold: isThreshold(r.judgeThreshold) ? r.judgeThreshold : DEFAULT_JUDGE_THRESHOLD,
		judgeLayout: isJudgeLayout(r.judgeLayout) ? r.judgeLayout : DEFAULT_JUDGE_LAYOUT,
		judgePrompt: isJudgePromptVersion(r.judgePrompt) ? r.judgePrompt : DEFAULT_JUDGE_PROMPT,
		judgeFacts: typeof r.judgeFacts === "boolean" ? r.judgeFacts : DEFAULT_JUDGE_FACTS,
	};
}

function asStringArray(v: unknown): string[] {
	if (!Array.isArray(v)) return [];
	return v.filter((x): x is string => typeof x === "string");
}

/**
 * Merge a project config onto a global one under the tighten-only rule:
 *
 * - `readOnlyTools`: when the project supplies the field the effective list is the
 *   intersection (project can only shrink the read-only set — i.e. gate more tools);
 *   otherwise the global list stands. A tool the project names that global never listed
 *   cannot be added.
 * - `hardDeny`: union (the project may add rules, never drop them).
 * - `level`: the global level always stands — a project can never change the explanation
 *   level, because it is a person's preference, not a policy a repo may set.
 * - `judgeMode` / `judgeThreshold`: a project may only *tighten*. It may set the
 *   mode to off or advise but never raise it to auto, and it may lower the threshold
 *   (medium→low) but never raise it. Both are enforced as "keep the less permissive value":
 *   for the mode, off < advise < auto, so the minimum can only lower it and can never
 *   introduce auto unless the global already granted it; for the threshold, low < medium.
 *   As with `readOnlyTools`, an existing project file that omits a judge field parses to the
 *   default (off / low), i.e. the tightest value — the same tighten-toward-safe behaviour.
 */
/**
 * A project config is a set of *overrides*: only the fields the file actually sets take part in
 * the merge, so a project file that omits the judge fields leaves the global judge alone (an
 * omitted field is "no opinion", not "the default"). Present fields may only tighten.
 */
export function parseProjectConfig(raw: unknown): Partial<PiGuruConfig> {
	const r = (raw ?? {}) as RawConfig;
	const out: Partial<PiGuruConfig> = {};
	if (Array.isArray(r.readOnlyTools)) out.readOnlyTools = asStringArray(r.readOnlyTools);
	if (Array.isArray(r.hardDeny)) out.hardDeny = asStringArray(r.hardDeny);
	if (isJudgeMode(r.judgeMode)) out.judgeMode = r.judgeMode;
	if (isThreshold(r.judgeThreshold)) out.judgeThreshold = r.judgeThreshold;
	return out;
}

export function loadProjectConfigFile(path: string): Partial<PiGuruConfig> | undefined {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
	try {
		return parseProjectConfig(JSON.parse(text));
	} catch {
		return undefined;
	}
}

export function mergeConfigs(global: PiGuruConfig, project: Partial<PiGuruConfig> | undefined): PiGuruConfig {
	if (!project) return { ...global };
	const readOnlyTools = project.readOnlyTools
		? global.readOnlyTools.filter((t) => project.readOnlyTools?.includes(t))
		: [...global.readOnlyTools];
	const hardDeny = [...new Set([...global.hardDeny, ...(project.hardDeny ?? [])])];
	return {
		readOnlyTools,
		hardDeny,
		level: global.level,
		judgeMode: project.judgeMode ? lessPermissiveMode(global.judgeMode, project.judgeMode) : global.judgeMode,
		judgeThreshold: project.judgeThreshold
			? lowerThreshold(global.judgeThreshold, project.judgeThreshold)
			: global.judgeThreshold,
		// The layout is not a policy a repo may set — the global value always stands (like `level`).
		judgeLayout: global.judgeLayout,
		// The prompt version is likewise not a repo policy — the global value always stands.
		judgePrompt: global.judgePrompt,
		// The facts toggle is likewise global-only — a project may not turn it off.
		judgeFacts: global.judgeFacts,
	};
}

const MODE_PERM: Record<JudgeMode, number> = { off: 0, advise: 1, auto: 2 };

/** The less permissive of two judge modes (off < advise < auto): a project may only tighten. */
function lessPermissiveMode(global: JudgeMode, project: JudgeMode): JudgeMode {
	return MODE_PERM[project] < MODE_PERM[global] ? project : global;
}

const THRESHOLD_PERM: Record<Threshold, number> = { low: 0, medium: 1 };

/** The lower of two thresholds (low < medium): a project may lower it, never raise it. */
function lowerThreshold(global: Threshold, project: Threshold): Threshold {
	return THRESHOLD_PERM[project] < THRESHOLD_PERM[global] ? project : global;
}

/** Read and parse a JSON config file, returning undefined when absent or unreadable. */
export function loadConfigFile(path: string): PiGuruConfig | undefined {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return undefined; // absent — not an error
	}
	try {
		return parseConfig(JSON.parse(text));
	} catch {
		return undefined; // malformed JSON — fall back to defaults
	}
}

/**
 * Load the effective config from a global and optional project path. A missing global
 * file yields defaults; the project file may only tighten.
 *
 * The project file is read **only when `projectTrusted` is true**. pi's
 * project-trust system does not gate `.pi/pi-guru.json`, so a repository you merely open
 * could otherwise supply pi-guru policy — including hard-deny regexes that ReDoS or brick
 * the gate. The parameter defaults to `false` (fail-closed): a caller must opt in by passing
 * `ctx.isProjectTrusted()`.
 */
export function loadEffectiveConfig(
	globalPath: string,
	projectPath?: string,
	projectTrusted = false,
): PiGuruConfig {
	const global = loadConfigFile(globalPath) ?? { ...EMPTY };
	const project = projectPath && projectTrusted ? loadProjectConfigFile(projectPath) : undefined;
	return mergeConfigs(global, project);
}

/**
 * Persist the explanation level to the global config file, preserving any other fields a
 * person has set. `/explain-level` writes here; the level lives in the global file only
 * (a project may not set it). Creates the file and its directory if absent.
 */
export function setLevelInConfig(globalPath: string, level: ExplanationLevel): void {
	let raw: Record<string, unknown> = {};
	try {
		const parsed = JSON.parse(readFileSync(globalPath, "utf8"));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			raw = parsed as Record<string, unknown>;
		}
	} catch {
		// absent or malformed — start from an empty object
	}
	raw.level = level;
	mkdirSync(dirname(globalPath), { recursive: true });
	writeFileSync(globalPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
}

/**
 * Persist the judge mode and threshold to the global config file, preserving any other fields
 * a person has set. `/judge` writes here; both live in the global file (a project may only
 * tighten them, never set them here). Creates the file and its directory if absent.
 */
export function setJudgeInConfig(globalPath: string, mode: JudgeMode, threshold: Threshold): void {
	let raw: Record<string, unknown> = {};
	try {
		const parsed = JSON.parse(readFileSync(globalPath, "utf8"));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			raw = parsed as Record<string, unknown>;
		}
	} catch {
		// absent or malformed — start from an empty object
	}
	raw.judgeMode = mode;
	raw.judgeThreshold = threshold;
	mkdirSync(dirname(globalPath), { recursive: true });
	writeFileSync(globalPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
}
