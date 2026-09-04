/**
 * pi-guru — the gate (slice 1) plus Explain and narration (slice 2).
 *
 * Every change call (bash, write, edit, and any tool not known to be read-only) stops for a
 * person before it runs; read calls pass silently but are narrated once per turn. A pipeline
 * of hard deny → session allow → gate → no-UI stop handoff decides each change call. At the
 * gate, **Explain** gives a plain-language account of the pending call at the current
 * explanation level. See CONTEXT.md for the vocabulary and docs/adr/0001 for why
 * this is a standalone extension.
 *
 * Explain and narration both speak through the session model (`ctx.model`) via
 * `ctx.modelRegistry.complete` — never a hard-coded provider. When no session model is
 * available they degrade: the gate shows without Explain, and narration is skipped, each
 * with a notify. The judge is the design notes; the gate leaves a `header` slot for its verdict.
 *
 * PI_GURU_SANDBOXED
 * ---------------------------
 * `PI_GURU_SANDBOXED=1` in pi's own environment means a sandbox launcher has already declared
 * OS-level confinement for this run. It is read **once at extension load** (never re-read from a
 * tool call). When a sandbox is declared pi-guru **stands aside**: it skips the gate and the
 * judge, writes no stop handoffs, and keeps only its deterministic hard denies (which then block
 * a single call without terminating the turn). It records one `pi-guru:standdown` session entry
 * naming the signal, and `/gate` and the status line show "sandboxed" so a person can see it.
 * As a convenience a second signal, **Linux-container auto-detection**, fires the same stand-down
 * (`/.dockerenv` exists, or `/proc/1/cgroup` mentions docker/containerd/lxc/podman). Container
 * detection is Linux-only — a macOS seatbelt sandbox is never inferred.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	getMarkdownTheme,
	isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";
import { SessionAllows } from "../src/allows.ts";
import { type AssessResult, assess, floorDecision, renderFactsBlock } from "../src/assess/index.ts";
import { classifyTool } from "../src/classify.ts";
import {
	loadEffectiveConfig,
	loadProjectConfigFile,
	type PiGuruConfig,
	setJudgeInConfig,
	setLevelInConfig,
} from "../src/config.ts";
import { makeExplainer } from "../src/explain.ts";
import { randomNonce } from "../src/fence.ts";
import {
	ALL_GATE_LEVELS,
	breakerDropped,
	effectiveJudgeMode,
	type GateLevel,
	isGateLevel,
	type ProjectJudgeView,
	resolveSessionJudge,
} from "../src/gate-level.ts";
import { confirmStopAsking, type GateOptions, presentGate } from "../src/gate-ui.ts";
import { writeHandoff } from "../src/handoff.ts";
import { buildRules } from "../src/hard-deny.ts";
import {
	applyFloor,
	CircuitBreaker,
	decideJudgeAction,
	type JudgeLayout,
	type JudgeMode,
	type JudgeOutcome,
	type LayoutContext,
	runJudge,
	type Threshold,
	verdictBadge,
} from "../src/judge.ts";
import { ALL_LEVELS, isExplanationLevel } from "../src/levels.ts";
import { type Completer, totalTokens } from "../src/model.ts";
import { assistantTextOf, collectReadCalls, runNarration } from "../src/narrate.ts";
import { normalizeBash, normalizeEdit, normalizeOther, normalizeWrite } from "../src/normalize.ts";
import { notify } from "../src/notify.ts";
import {
	type EntryData,
	type EntryKind,
	type JudgeStage,
	type NormalizedCall,
	type PipelineDeps,
	runPipeline,
} from "../src/pipeline.ts";
import { detectSandbox } from "../src/sandbox.ts";
import { buildConversationText, entriesToMessages, type SessionEntryLike } from "../src/transcript.ts";

/** How long the judge may run before its call is aborted and the verdict is unavailable. */
const JUDGE_TIMEOUT_MS = 60_000;

/** Entry kinds are namespaced under `pi-guru:` in the session. */
const ENTRY_PREFIX = "pi-guru";

/** The active session model, as `ctx` exposes it — never a hard-coded provider or model. */
type SessionModel = NonNullable<ExtensionContext["model"]>;

/** A session entry recording a spoken account (Explain or narration) and its token cost. */
interface SpeechEntry {
	kind: "explain" | "narration";
	level: string;
	markdown: string;
	tokens: number;
	timestamp: number;
}

/** A session entry recording a change to the session gate level. */
interface GateLevelEntry {
	level: GateLevel;
	detail: string;
	timestamp: number;
}

/** This session's judge counts, shown on the status line and by `/judge`. */
interface JudgeCounts {
	autoApproved: number;
	gated: number;
	denied: number;
	failures: number;
}

/** Per-session judge state, held in the extension closure (nothing persisted but config). */
interface JudgeState {
	counts: JudgeCounts;
	breaker: CircuitBreaker;
	notifiedTrip: boolean;
}

export default function (pi: ExtensionAPI) {
	// The global config lives at ~/.pi/agent/pi-guru.json. `PI_GURU_CONFIG` overrides that path
	// — used to point the config elsewhere for non-interactive (`pi -p`) checks without touching
	// a person's real config. `/explain-level` and `/judge` write to this path.
	const globalConfigPath = process.env.PI_GURU_CONFIG ?? join(getAgentDir(), "pi-guru.json");
	// Read the sandbox signal once, at load — never re-read from a tool call. A declared
	// (or auto-detected) sandbox makes pi-guru stand aside; see the PI_GURU_SANDBOXED note above.
	const sandbox = detectSandbox();
	// The standdown entry is recorded once per session (on the first change call while sandboxed).
	let standdownAnnounced = false;
	const allows = new SessionAllows();
	// Degrade notices fire once per session so a missing model does not spam the person.
	const notified = { explain: false, narration: false };
	// Judge state, per session, in memory: counts for the status line and /judge, the circuit
	// breaker, and whether the breaker's one-time "dropped to advise" notice has fired.
	const judge: JudgeState = {
		counts: { autoApproved: 0, gated: 0, denied: 0, failures: 0 },
		breaker: new CircuitBreaker(),
		notifiedTrip: false,
	};
	// One nonce for the whole pi session, so the `prefix-stable` judge layout's fenced-transcript
	// prefix stays byte-identical (hence cacheable) as the transcript grows. Unused by `current`.
	const judgeSessionNonce = randomNonce();
	// The session gate level: how much pi-guru asks this session. Runtime-only, never
	// persisted; a new session starts at `ask` (so production is byte-identical without a change).
	let gateLevel: GateLevel = "ask";

	for (const kind of ["hard-deny", "decision", "handoff", "auto-approve", "standdown"] as EntryKind[]) {
		registerDecisionRenderer(pi, kind);
	}
	registerSpeechRenderer(pi, "explain");
	registerSpeechRenderer(pi, "narration");
	registerGateLevelRenderer(pi);

	/** The project config's judge fields, for the gate-level cap; undefined in an untrusted repo. */
	const projectJudgeView = (ctx: ExtensionContext): ProjectJudgeView | undefined => {
		if (!ctx.isProjectTrusted()) return undefined;
		return loadProjectConfigFile(join(ctx.cwd, CONFIG_DIR_NAME, "pi-guru.json"));
	};

	/**
	 * Apply a requested session gate level: resolve the project cap, require a model for
	 * an auto level (else stay put), then set the level, record a `pi-guru:gate-level` entry, and
	 * refresh the status line. The `off` typed confirmation is the caller's job. Returns whether the
	 * level changed. Shared by the gate's second menu and `/gate level`.
	 */
	const applyLevel = (ctx: ExtensionContext, requested: GateLevel, config: PiGuruConfig): boolean => {
		const resolve = resolveSessionJudge(requested, config, projectJudgeView(ctx));
		const auto = resolve.appliedLevel === "auto-low" || resolve.appliedLevel === "auto-medium";
		if (auto && !pickSessionModel(ctx)) {
			ctx.ui.notify(`pi-guru: no session model available — staying at ${gateLevel}`, "warning");
			return false;
		}
		gateLevel = resolve.appliedLevel;
		// Setting any gate level is an explicit, present-person choice: clear a prior circuit-breaker
		// trip so it does not linger over the fresh choice. A session auto level ignores the
		// breaker anyway; this also gives a return to `ask` a clean slate.
		judge.breaker.reset();
		judge.notifiedTrip = false;
		if (resolve.capped) {
			ctx.ui.notify(
				`pi-guru: this project caps the gate level at ${resolve.appliedLevel} (requested ${requested})`,
				"info",
			);
		}
		pi.appendEntry<GateLevelEntry>(`${ENTRY_PREFIX}:gate-level`, {
			level: gateLevel,
			detail: resolve.capped
				? `session gate level set to ${gateLevel} (capped from ${requested} by this project) — resets when the session ends`
				: `session gate level set to ${gateLevel} — resets when the session ends`,
			timestamp: Date.now(),
		});
		updateStatus(
			ctx,
			gateLevel,
			effectiveJudgeMode(resolve.mode, judge.breaker.tripped, gateLevel),
			resolve.threshold,
			judge.counts,
			breakerDropped(resolve.mode, judge.breaker.tripped, gateLevel),
		);
		ctx.ui.notify(`pi-guru: gate level set to ${gateLevel}`, "info");
		return true;
	};

	pi.on("tool_call", async (event, ctx) => {
		try {
			const projectConfigPath = join(ctx.cwd, CONFIG_DIR_NAME, "pi-guru.json");
			// The project config is honored only in a trusted repo — pi's trust system does not
			// gate .pi/pi-guru.json, so an untrusted repo must not supply policy.
			const config = loadEffectiveConfig(globalConfigPath, projectConfigPath, ctx.isProjectTrusted());

			if (classifyTool(event.toolName, config.readOnlyTools) === "read") {
				return undefined; // read call — never gated
			}

			const call = normalize(event);
			const rules = buildRules(config.hardDeny);

			// The project judge view (for the gate-level cap) is read once per call; the status line
			// reflects the live session gate level and its resolved judge mode/threshold.
			const projectView = projectJudgeView(ctx);
			const refreshStatus = () => {
				const r = resolveSessionJudge(gateLevel, config, projectView);
				updateStatus(
					ctx,
					gateLevel,
					effectiveJudgeMode(r.mode, judge.breaker.tripped, gateLevel),
					r.threshold,
					judge.counts,
					breakerDropped(r.mode, judge.breaker.tripped, gateLevel),
				);
			};

			// The standdown entry is recorded once per session; a gate denial counts toward the
			// judge stats (status line + /judge). Shared by both branches below.
			const appendEntry = (kind: EntryKind, data: EntryData) => {
				if (kind === "standdown") {
					if (standdownAnnounced) return;
					standdownAnnounced = true;
				}
				if (kind === "decision" && data.outcome === "denied") {
					judge.counts.denied++;
					refreshStatus();
				}
				pi.appendEntry(`${ENTRY_PREFIX}:${kind}`, data);
			};

			// Sandbox declared — stand aside from the gate and judge. The gate/handoff
			// callbacks are never reached in this branch; they throw to make that invariant loud.
			if (sandbox.active) {
				ctx.ui.setStatus("pi-guru", "sandboxed");
				return await runPipeline(call, {
					rules,
					allows,
					cwd: ctx.cwd,
					hasUI: ctx.hasUI,
					sandbox,
					gate: () => {
						throw new Error("pi-guru: gate unreachable while sandboxed");
					},
					writeHandoff: () => {
						throw new Error("pi-guru: handoff unreachable while sandboxed");
					},
					appendEntry,
				});
			}

			// The deterministic assessor runs once per change call: its facts feed the judge
			// and Explain, and its floor is applied to the verdict. Computed here so both stages share it.
			const assessment = assess(call, { cwd: ctx.cwd, home: homedir() });
			// The facts block is trusted context for the judge and Explain; off when judgeFacts is off.
			const factsBlock = config.judgeFacts
				? renderFactsBlock(assessment.facts, assessment.unresolved)
				: undefined;
			const gateOptions = buildGateOptions(pi, ctx, config.level, call, notified, factsBlock);

			// Build the deps for the current session gate level. `applyGateLevel` re-runs
			// this same builder after a level change, so the pending call is re-evaluated under the new
			// level through the pipeline. At `ask` this resolves to the config's own judge (byte-identical).
			const buildPipelineDeps = (): PipelineDeps => {
				const resolve = resolveSessionJudge(gateLevel, config, projectView);
				const effMode = effectiveJudgeMode(resolve.mode, judge.breaker.tripped, gateLevel);
				// The breaker only applies at gate level `ask`: a session auto level is an
				// explicit choice, so the breaker neither drops it nor fires a "dropped to advise" notice.
				// `dropped` is the current dropped state (for the gate header), false until the breaker
				// actually trips under `ask`.
				const breakerApplies = gateLevel === "ask";
				const dropped = breakerDropped(resolve.mode, judge.breaker.tripped, gateLevel);
				refreshStatus();
				return {
					rules,
					allows,
					cwd: ctx.cwd,
					hasUI: ctx.hasUI,
					gateOff: resolve.gateOff,
					judge: buildJudgeStage(
						ctx,
						config,
						call,
						judge,
						effMode,
						resolve.threshold,
						judgeSessionNonce,
						assessment,
						factsBlock,
						refreshStatus,
						breakerApplies,
						dropped,
					),
					gate: (req) => presentGate(ctx, req, { ...gateOptions, gateLevel }),
					applyGateLevel: (requested) => (applyLevel(ctx, requested, config) ? buildPipelineDeps() : null),
					writeHandoff: (details) => writeHandoff(ctx.cwd, details).path,
					appendEntry,
				};
			};

			return await runPipeline(call, buildPipelineDeps());
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return { block: true, reason: `pi-guru: blocked for safety after an internal error (${message})` };
		}
	});

	// Narration: one account of the turn's read calls, appended without stopping the agent.
	pi.on("turn_end", async (event, ctx) => {
		try {
			const projectConfigPath = join(ctx.cwd, CONFIG_DIR_NAME, "pi-guru.json");
			const config = loadEffectiveConfig(globalConfigPath, projectConfigPath, ctx.isProjectTrusted());
			if (config.level === "off") return;

			const reads = collectReadCalls(event.message, config.readOnlyTools);
			if (reads.length === 0) return; // nothing was read — nothing to narrate

			const model = pickSessionModel(ctx);
			if (!model) {
				if (!notified.narration) {
					ctx.ui.notify("pi-guru: narration off for this session — no session model available", "warning");
					notified.narration = true;
				}
				return;
			}

			const narration = await runNarration({
				level: config.level,
				reads,
				assistantText: assistantTextOf(event.message),
				complete: makeCompleter(ctx, model),
			});
			pi.appendEntry<SpeechEntry>(`${ENTRY_PREFIX}:narration`, {
				kind: "narration",
				level: config.level,
				markdown: narration.markdown,
				tokens: totalTokens(narration.usage),
				timestamp: Date.now(),
			});
		} catch {
			// Narration must never break a turn; a failed narration is simply absent.
		}
	});

	// /explain-level — show or set the explanation level (persisted to the global config).
	// `/explain` is registered as an alias so a person who types the shorter,
	// more natural command isn't met with a silent no-op that goes to the model as text
	//. Both share one handler and one set of completions.
	const levelCompletions = (prefix: string) =>
		ALL_LEVELS.filter((l) => l.startsWith(prefix)).map((l) => ({ value: l, label: l }));
	const showOrSetLevel = async (args: string, ctx: ExtensionContext) => {
		const arg = args.trim();
		if (arg === "") {
			const level = loadEffectiveConfig(globalConfigPath).level;
			ctx.ui.notify(`pi-guru: explanation level is ${level}`, "info");
			return;
		}
		if (!isExplanationLevel(arg)) {
			// A usage error must not vanish under `pi -p`, where notify is a no-op.
			notify(ctx, `pi-guru: unknown level '${arg}' — use ${ALL_LEVELS.join(", ")}`, "warning");
			return;
		}
		setLevelInConfig(globalConfigPath, arg);
		ctx.ui.notify(`pi-guru: explanation level set to ${arg}`, "info");
	};
	pi.registerCommand("explain-level", {
		description: "Show or set pi-guru's explanation level [fundamental|intermediate|technical|off]",
		getArgumentCompletions: levelCompletions,
		handler: showOrSetLevel,
	});
	pi.registerCommand("explain", {
		description: "Alias of /explain-level — show or set pi-guru's explanation level",
		getArgumentCompletions: levelCompletions,
		handler: showOrSetLevel,
	});

	// /gate — list session allows and the session gate level; `/gate clear` clears the allows;
	// `/gate level [ask|auto-low|auto-medium|off]` shows or sets the gate level.
	pi.registerCommand("gate", {
		description:
			"Show pi-guru session allows and gate level; `/gate clear`; `/gate level [ask|auto-low|auto-medium|off]`",
		getArgumentCompletions: (prefix) => {
			const options = ["clear", "level", ...ALL_GATE_LEVELS];
			return options.filter((o) => o.startsWith(prefix)).map((o) => ({ value: o, label: o }));
		},
		handler: async (args, ctx) => {
			if (sandbox.active) {
				ctx.ui.setStatus("pi-guru", "sandboxed");
				ctx.ui.notify(
					`pi-guru: sandboxed (${sandbox.signal}) — the gate and judge are off for this run; hard denies still apply.`,
					"info",
				);
				return;
			}
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			if (tokens[0] === "level") {
				await gateLevelCommand(ctx, tokens[1]);
				return;
			}
			if (tokens[0] === "clear") {
				allows.clear();
				ctx.ui.notify("pi-guru: session allows cleared", "info");
				return;
			}
			const { commands, directories } = allows.list();
			const lines = [
				`Gate level: ${gateLevel}`,
				allows.isEmpty() ? "No session allows yet" : "",
				commands.length ? `Commands: ${commands.join(", ")}` : "",
				directories.length ? `Write dirs: ${directories.join(", ")}` : "",
			].filter(Boolean);
			ctx.ui.notify(`pi-guru —\n${lines.join("\n")}`, "info");
		},
	});

	/** Show or set the session gate level for `/gate level`. */
	async function gateLevelCommand(ctx: ExtensionContext, arg: string | undefined): Promise<void> {
		if (arg === undefined) {
			ctx.ui.notify(`pi-guru: gate level is ${gateLevel}`, "info");
			return;
		}
		if (!isGateLevel(arg)) {
			// A usage error must not vanish under `pi -p`, where notify is a no-op.
			notify(ctx, `pi-guru: unknown gate level '${arg}' — use ${ALL_GATE_LEVELS.join(", ")}`, "warning");
			return;
		}
		if (!ctx.hasUI) {
			// The gate level is a supervised-session control; there is nothing to loosen with no UI.
			notify(ctx, "pi-guru: the gate level needs an interactive session", "warning");
			return;
		}
		// `off` takes effect only after the person types the phrase, like the second menu.
		if (arg === "off" && !(await confirmStopAsking(ctx))) {
			ctx.ui.notify("pi-guru: gate level unchanged", "info");
			return;
		}
		const config = loadEffectiveConfig(
			globalConfigPath,
			join(ctx.cwd, CONFIG_DIR_NAME, "pi-guru.json"),
			ctx.isProjectTrusted(),
		);
		applyLevel(ctx, arg, config);
	}

	// /judge — show or set the judge mode and threshold (persisted to the global config).
	pi.registerCommand("judge", {
		description: "Show or set the pi-guru judge: /judge [off|advise|auto] [low|medium]",
		getArgumentCompletions: (prefix) => {
			const options = ["off", "advise", "auto", "low", "medium"];
			return options.filter((o) => o.startsWith(prefix)).map((o) => ({ value: o, label: o }));
		},
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const config = loadEffectiveConfig(
				globalConfigPath,
				join(ctx.cwd, CONFIG_DIR_NAME, "pi-guru.json"),
				ctx.isProjectTrusted(),
			);

			if (tokens.length === 0) {
				const effMode = effectiveJudgeMode(config.judgeMode, judge.breaker.tripped, gateLevel);
				const modeText = effMode === "auto" ? `auto (threshold ${config.judgeThreshold})` : effMode;
				// The breaker drop is reported only when it actually applies (configured auto at gate
				// level `ask`, the design notes); a session auto level ignores a tripped breaker.
				const dropped = breakerDropped(config.judgeMode, judge.breaker.tripped, gateLevel);
				const trippedText = dropped
					? " — dropped to advise this session (/gate level auto-medium or /judge auto)"
					: "";
				const { autoApproved, gated, denied, failures } = judge.counts;
				ctx.ui.notify(
					`pi-guru judge: ${modeText}${trippedText}\nthis session — auto-approved: ${autoApproved}, gated: ${gated}, denied: ${denied}, judge failures: ${failures}`,
					"info",
				);
				updateStatus(ctx, gateLevel, effMode, config.judgeThreshold, judge.counts, dropped);
				return;
			}

			const mode = tokens[0];
			if (mode !== "off" && mode !== "advise" && mode !== "auto") {
				// A usage error must not vanish under `pi -p`, where notify is a no-op.
				notify(ctx, `pi-guru: unknown judge mode '${mode}' — use off, advise, or auto`, "warning");
				return;
			}
			let threshold: Threshold = config.judgeThreshold;
			if (tokens[1] !== undefined) {
				if (tokens[1] !== "low" && tokens[1] !== "medium") {
					// A usage error must not vanish under `pi -p`, where notify is a no-op.
					notify(ctx, `pi-guru: unknown threshold '${tokens[1]}' — use low or medium`, "warning");
					return;
				}
				threshold = tokens[1];
			}

			// An explicit set is the person overriding: clear any circuit-breaker trip so a
			// freshly chosen auto mode takes effect (the counts stay — they are the session record).
			setJudgeInConfig(globalConfigPath, mode, threshold);
			judge.breaker.reset();
			judge.notifiedTrip = false;

			// A project config may only tighten; report what will actually take effect.
			const effective = loadEffectiveConfig(
				globalConfigPath,
				join(ctx.cwd, CONFIG_DIR_NAME, "pi-guru.json"),
				ctx.isProjectTrusted(),
			);
			const setText = mode === "auto" ? `auto (threshold ${threshold})` : mode;
			const effText =
				effective.judgeMode === mode && effective.judgeThreshold === threshold
					? ""
					: ` (this project tightens it to ${effective.judgeMode === "auto" ? `auto/${effective.judgeThreshold}` : effective.judgeMode})`;
			ctx.ui.notify(`pi-guru: judge set to ${setText}${effText}`, "info");
			updateStatus(ctx, gateLevel, effective.judgeMode, effective.judgeThreshold, judge.counts);
		},
	});
}

/**
 * Build the gate's Explain capability for one change call, or leave it off when the level
 * is off, there is no UI, or no session model is available (degrading with one notify).
 */
function buildGateOptions(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	level: ReturnType<typeof loadEffectiveConfig>["level"],
	call: NormalizedCall,
	notified: { explain: boolean; narration: boolean },
	factsBlock: string | undefined,
): GateOptions {
	if (level === "off" || !ctx.hasUI) return {};

	const model = pickSessionModel(ctx);
	if (!model) {
		if (!notified.explain) {
			ctx.ui.notify("pi-guru: Explain off for this session — no session model available", "warning");
			notified.explain = true;
		}
		return {};
	}

	const explainer = makeExplainer({
		startLevel: level,
		subject: { title: call.title, detail: call.detail },
		transcript: safeTranscript(ctx),
		complete: makeCompleter(ctx, model),
		factsBlock,
		onStep: (step) =>
			pi.appendEntry<SpeechEntry>(`${ENTRY_PREFIX}:explain`, {
				kind: "explain",
				level: step.level,
				markdown: step.markdown,
				tokens: totalTokens(step.usage),
				timestamp: Date.now(),
			}),
	});
	return { explainer, startLevel: level };
}

/** The session model, only if it exists and has configured auth. Never a hard-coded model. */
function pickSessionModel(ctx: ExtensionContext): SessionModel | undefined {
	const model = ctx.model;
	if (!model) return undefined;
	return ctx.modelRegistry.hasConfiguredAuth(model) ? model : undefined;
}

/** Wire a session-model completion to the injected `Completer` the pure logic consumes. */
function makeCompleter(ctx: ExtensionContext, model: SessionModel): Completer {
	return (context) =>
		ctx.modelRegistry.complete(model, context, {
			signal: ctx.signal,
			cacheRetention: "none",
			sessionId: uuidv7(),
		});
}

/**
 * The judge's completer: like `makeCompleter`, but bounded by a 60 s timeout combined with
 * `ctx.signal` (so Esc still cancels), and — when the model supports it — `reasoning: "low"`
 * to keep the verdict cheap. A timeout aborts the call, which `runJudge` turns into an
 * unavailable verdict, so the pipeline falls through to the gate. (The pi stream option that
 * caps reasoning is `reasoning`; the issue calls it `reasoningEffort`.)
 */
function makeJudgeCompleter(ctx: ExtensionContext, model: SessionModel): Completer {
	return (context) => {
		const timeout = AbortSignal.timeout(JUDGE_TIMEOUT_MS);
		const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
		return ctx.modelRegistry.complete(model, context, {
			signal,
			reasoning: model.reasoning ? "low" : undefined,
			cacheRetention: "none",
			sessionId: uuidv7(),
		});
	};
}

/**
 * Update the status line: `judge:<mode>[/<threshold>] a:<n> g:<n> d:<n>`, prefixed
 * with `gate:<level>` only when the session gate level is not `ask` — so at `ask`
 * (the default) the line is byte-identical to a build without the gate level. When the circuit
 * breaker has dropped a configured auto to advise, the mode reads `auto→advise` so the
 * drop is visible at a glance; `dropped` is false everywhere except that state (only reachable at
 * `ask`), keeping every other line byte-identical.
 */
function updateStatus(
	ctx: ExtensionContext,
	gateLevel: GateLevel,
	mode: JudgeMode,
	threshold: Threshold,
	counts: JudgeCounts,
	dropped = false,
): void {
	const modeText = dropped ? "auto→advise" : mode === "auto" ? `auto/${threshold}` : mode;
	const judgeText = `judge:${modeText} a:${counts.autoApproved} g:${counts.gated} d:${counts.denied}`;
	ctx.ui.setStatus("pi-guru", gateLevel === "ask" ? judgeText : `gate:${gateLevel} ${judgeText}`);
}

/**
 * Build the judge stage for one change call, or leave it off. The stage is off when the
 * effective mode is off, and also when it is advise with no UI (the verdict would only feed a
 * gate that never renders — the pipeline's existing no-UI handoff stands). auto always runs,
 * with or without UI, so it can approve unattended within the threshold.
 *
 * On each call the stage runs the judge on the session model (or reports it unavailable when
 * there is none), applies the threshold via `decideJudgeAction`, updates the session counts
 * and circuit breaker, notifies once when the breaker trips, and refreshes the status line.
 */
function buildJudgeStage(
	ctx: ExtensionContext,
	config: PiGuruConfig,
	call: NormalizedCall,
	judge: JudgeState,
	effMode: JudgeMode,
	threshold: Threshold,
	sessionNonce: string,
	assessment: AssessResult,
	factsBlock: string | undefined,
	refreshStatus: () => void,
	// The breaker applies only at gate level `ask`: elsewhere a trip neither notifies nor
	// changes the header, because a session auto level was an explicit, present-person choice.
	breakerApplies: boolean,
	// True when the breaker has already dropped a configured auto to advise this session, so the gate
	// header on this (and every later) gate says so.
	dropped: boolean,
): JudgeStage | undefined {
	if (effMode === "off") return undefined;
	if (effMode === "advise" && !ctx.hasUI) return undefined;
	const mode: "advise" | "auto" = effMode === "auto" ? "auto" : "advise";
	// The deterministic floor, applied to the verdict below. `undefined` when nothing floors.
	const floor = floorDecision(assessment.facts);

	return async () => {
		const model = pickSessionModel(ctx);
		const rawOutcome: JudgeOutcome = model
			? await runJudge({
					level: config.level,
					subject: { title: call.title, detail: call.detail },
					transcript: safeTranscript(ctx),
					complete: makeJudgeCompleter(ctx, model),
					layout: config.judgeLayout,
					layoutCtx: buildLayoutContext(ctx, config.judgeLayout, sessionNonce),
					promptVersion: config.judgePrompt,
					factsBlock,
				})
			: { available: false, reason: "no session model available" };

		// Apply the floor before the threshold decision, so a floored call is gated, and before the
		// badge, so the header shows why (max(verdict, floor); the verdict never drops, the design notes).
		const outcome: JudgeOutcome = rawOutcome.available
			? { ...rawOutcome, verdict: applyFloor(rawOutcome.verdict, floor) }
			: rawOutcome;

		if (!outcome.available) judge.counts.failures++;
		const action = decideJudgeAction(mode, threshold, outcome);

		if (action.kind === "auto-approve") {
			judge.counts.autoApproved++;
			const tripped = judge.breaker.record(action.verdict.risk, true);
			// Only report the drop when the breaker actually applies (configured auto at gate level
			// `ask`, the design notes) — a session auto level ignores the trip, so it must not say otherwise.
			if (tripped && breakerApplies && !judge.notifiedTrip) {
				judge.notifiedTrip = true;
				ctx.ui.notify(
					"pi-guru: judge dropped to advise for this session (circuit breaker) — you'll decide at the gate. To resume auto-approvals: /gate level auto-medium or /judge auto",
					"warning",
				);
			}
			refreshStatus();
			return { kind: "auto-approve", verdictLine: verdictBadge(action.verdict) };
		}

		judge.counts.gated++;
		if (outcome.available) judge.breaker.record(outcome.verdict.risk, false);
		refreshStatus();
		// While the breaker holds the session in advise, the gate header says so, so the
		// person knows why they are deciding this and how it changed.
		const header = dropped ? `judge dropped to advise (circuit breaker) · ${action.header}` : action.header;
		return { kind: "gate", header };
	};
}

/** The flattened conversation, or an empty string if it cannot be read. */
function safeTranscript(ctx: ExtensionContext): string {
	try {
		return buildConversationText(ctx.sessionManager.buildContextEntries() as unknown as SessionEntryLike[]);
	} catch {
		return "";
	}
}

/**
 * Assemble the layout-specific inputs `runJudge` needs. `current` needs nothing. `prefix-stable`
 * carries the per-session nonce so its fenced-transcript prefix is stable across the session.
 * `shared-prefix` supplies the agent's own system prompt and message array (tool results truncated
 * at 4k chars by `entriesToMessages`) so the judge call rides the agent's already-resident prefix;
 * on any read failure it falls back to empty inputs, which `buildJudgeRequest` handles.
 */
function buildLayoutContext(ctx: ExtensionContext, layout: JudgeLayout, sessionNonce: string): LayoutContext {
	if (layout === "prefix-stable") return { sessionNonce };
	if (layout === "shared-prefix") {
		let agentSystemPrompt = "";
		let agentMessages: LayoutContext["agentMessages"] = [];
		try {
			agentSystemPrompt = ctx.getSystemPrompt();
			const entries = ctx.sessionManager.buildContextEntries() as unknown as SessionEntryLike[];
			agentMessages = entriesToMessages(entries) as LayoutContext["agentMessages"];
		} catch {
			// A read failure leaves the fallbacks; the layout still fences the pending action itself.
		}
		return { agentSystemPrompt, agentMessages };
	}
	return {};
}

/** Map a change-call event into a NormalizedCall. */
function normalize(event: ToolCallEvent): NormalizedCall {
	if (isToolCallEventType("bash", event)) {
		return normalizeBash(event.input.command);
	}
	if (isToolCallEventType("write", event)) {
		return normalizeWrite(event.input.path, event.input.content);
	}
	if (isToolCallEventType("edit", event)) {
		return normalizeEdit(event.input.path, event.input.edits);
	}
	return normalizeOther(event.toolName, event.input);
}

/** Register the text renderer for a decision entry kind (hard-deny, decision, handoff). */
function registerDecisionRenderer(pi: ExtensionAPI, kind: EntryKind): void {
	pi.registerEntryRenderer<EntryData>(`${ENTRY_PREFIX}:${kind}`, (entry, { expanded }, theme) => {
		const data = entry.data;
		const label = data ? `${data.outcome}: ${data.toolName}` : kind;
		const box = new Box(1, 0, (t) => theme.bg("customMessageBg", t));
		box.addChild(new Text(`${theme.fg("accent", "[pi-guru]")} ${label}`, 0, 0));
		if (expanded && data) {
			box.addChild(new Text(theme.fg("dim", data.detail), 0, 0));
			if (data.reason) box.addChild(new Text(theme.fg("dim", data.reason), 0, 0));
			if (data.handoffPath) box.addChild(new Text(theme.fg("dim", `handoff: ${data.handoffPath}`), 0, 0));
		}
		return box;
	});
}

/** Register the Markdown renderer for a spoken entry kind (explain, narration). */
function registerSpeechRenderer(pi: ExtensionAPI, kind: SpeechEntry["kind"]): void {
	pi.registerEntryRenderer<SpeechEntry>(`${ENTRY_PREFIX}:${kind}`, (entry, { expanded }, theme) => {
		const data = entry.data;
		const summary = data ? `${kind} (${data.level}) · ${data.tokens} tokens` : kind;
		const box = new Box(1, 0, (t) => theme.bg("customMessageBg", t));
		box.addChild(new Text(`${theme.fg("accent", "[pi-guru]")} ${summary}`, 0, 0));
		if (expanded && data) box.addChild(new Markdown(data.markdown, 0, 0, getMarkdownTheme()));
		return box;
	});
}

/** Register the renderer for a session gate-level change entry. */
function registerGateLevelRenderer(pi: ExtensionAPI): void {
	pi.registerEntryRenderer<GateLevelEntry>(`${ENTRY_PREFIX}:gate-level`, (entry, { expanded }, theme) => {
		const data = entry.data;
		const box = new Box(1, 0, (t) => theme.bg("customMessageBg", t));
		box.addChild(new Text(`${theme.fg("accent", "[pi-guru]")} gate level → ${data?.level ?? "?"}`, 0, 0));
		if (expanded && data?.detail) box.addChild(new Text(theme.fg("dim", data.detail), 0, 0));
		return box;
	});
}
