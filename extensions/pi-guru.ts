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
import { loadEffectiveConfig, type PiGuruConfig, setJudgeInConfig, setLevelInConfig } from "../src/config.ts";
import { makeExplainer } from "../src/explain.ts";
import { randomNonce } from "../src/fence.ts";
import { type GateOptions, presentGate } from "../src/gate-ui.ts";
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

	for (const kind of ["hard-deny", "decision", "handoff", "auto-approve", "standdown"] as EntryKind[]) {
		registerDecisionRenderer(pi, kind);
	}
	registerSpeechRenderer(pi, "explain");
	registerSpeechRenderer(pi, "narration");

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

			// The standdown entry is recorded once per session; a gate denial counts toward the
			// judge stats (status line + /judge). Shared by both branches below.
			const appendEntry = (kind: EntryKind, data: EntryData) => {
				if (kind === "standdown") {
					if (standdownAnnounced) return;
					standdownAnnounced = true;
				}
				if (kind === "decision" && data.outcome === "denied") {
					judge.counts.denied++;
					updateStatus(
						ctx,
						effectiveJudgeMode(config.judgeMode, judge.breaker.tripped),
						config.judgeThreshold,
						judge.counts,
					);
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
			const effMode = effectiveJudgeMode(config.judgeMode, judge.breaker.tripped);
			updateStatus(ctx, effMode, config.judgeThreshold, judge.counts);

			return await runPipeline(call, {
				rules,
				allows,
				cwd: ctx.cwd,
				hasUI: ctx.hasUI,
				judge: buildJudgeStage(ctx, config, call, judge, effMode, judgeSessionNonce, assessment, factsBlock),
				gate: (req) => presentGate(ctx, req, gateOptions),
				writeHandoff: (details) => writeHandoff(ctx.cwd, details).path,
				appendEntry,
			});
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

	// /gate — list session allows; /gate clear — clear them.
	pi.registerCommand("gate", {
		description: "Show pi-guru session allows; `/gate clear` clears them",
		handler: async (args, ctx) => {
			if (sandbox.active) {
				ctx.ui.setStatus("pi-guru", "sandboxed");
				ctx.ui.notify(
					`pi-guru: sandboxed (${sandbox.signal}) — the gate and judge are off for this run; hard denies still apply.`,
					"info",
				);
				return;
			}
			if (args.trim() === "clear") {
				allows.clear();
				ctx.ui.notify("pi-guru: session allows cleared", "info");
				return;
			}
			const { commands, directories } = allows.list();
			if (allows.isEmpty()) {
				ctx.ui.notify("pi-guru: no session allows yet", "info");
				return;
			}
			const lines = [
				commands.length ? `Commands: ${commands.join(", ")}` : "",
				directories.length ? `Write dirs: ${directories.join(", ")}` : "",
			].filter(Boolean);
			ctx.ui.notify(`pi-guru session allows —\n${lines.join("\n")}`, "info");
		},
	});

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
				const effMode = effectiveJudgeMode(config.judgeMode, judge.breaker.tripped);
				const modeText = effMode === "auto" ? `auto (threshold ${config.judgeThreshold})` : effMode;
				const tripped =
					config.judgeMode === "auto" && judge.breaker.tripped ? " — dropped to advise this session" : "";
				const { autoApproved, gated, denied, failures } = judge.counts;
				ctx.ui.notify(
					`pi-guru judge: ${modeText}${tripped}\nthis session — auto-approved: ${autoApproved}, gated: ${gated}, denied: ${denied}, judge failures: ${failures}`,
					"info",
				);
				updateStatus(ctx, effMode, config.judgeThreshold, judge.counts);
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
			judge.breaker = new CircuitBreaker();
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
			updateStatus(ctx, effective.judgeMode, effective.judgeThreshold, judge.counts);
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

/** The judge mode actually in force: a tripped circuit breaker drops auto to advise. */
function effectiveJudgeMode(configured: JudgeMode, tripped: boolean): JudgeMode {
	return configured === "auto" && tripped ? "advise" : configured;
}

/** Update the status line: `judge:<mode>[/<threshold>] a:<n> g:<n> d:<n>`. */
function updateStatus(
	ctx: ExtensionContext,
	mode: JudgeMode,
	threshold: Threshold,
	counts: JudgeCounts,
): void {
	const modeText = mode === "auto" ? `auto/${threshold}` : mode;
	ctx.ui.setStatus(
		"pi-guru",
		`judge:${modeText} a:${counts.autoApproved} g:${counts.gated} d:${counts.denied}`,
	);
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
	sessionNonce: string,
	assessment: AssessResult,
	factsBlock: string | undefined,
): JudgeStage | undefined {
	if (effMode === "off") return undefined;
	if (effMode === "advise" && !ctx.hasUI) return undefined;
	const mode: "advise" | "auto" = effMode === "auto" ? "auto" : "advise";
	const threshold = config.judgeThreshold;
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
			if (tripped && !judge.notifiedTrip) {
				judge.notifiedTrip = true;
				ctx.ui.notify(
					"pi-guru: judge dropped to advise for this session (circuit breaker) — you'll decide at the gate",
					"warning",
				);
			}
			updateStatus(ctx, effectiveJudgeMode(config.judgeMode, judge.breaker.tripped), threshold, judge.counts);
			return { kind: "auto-approve", verdictLine: verdictBadge(action.verdict) };
		}

		judge.counts.gated++;
		if (outcome.available) judge.breaker.record(outcome.verdict.risk, false);
		updateStatus(ctx, effectiveJudgeMode(config.judgeMode, judge.breaker.tripped), threshold, judge.counts);
		return { kind: "gate", header: action.header };
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
