/**
 * The gate: the approval prompt shown before a change call runs (CONTEXT.md).
 *
 * It offers Approve, Approve for this session, Deny, and Deny with a reason — and, when an
 * explainer is supplied (the level is not off and a session model is available), **Explain**
 * as the first choice and the default. Choosing Explain runs the session model,
 * renders the explanation as Markdown above the choices inside the same dialog, and moves
 * the default to Approve; choosing it again steps one level deeper. A `header?` slot sits
 * above the explanation for the judge's verdict, rendered only when present.
 *
 * In TUI mode the prompt is a `ctx.ui.custom` component (which can preselect a default and
 * re-render after an explanation); in other UI modes it falls back to a `ctx.ui.select`
 * loop that shows each explanation in the dialog text.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import type { ExplainStep } from "./explain.ts";
import type { GateLevel } from "./gate-level.ts";
import type { SpokenLevel } from "./levels.ts";

export type GateChoice = "explain" | "approve" | "approve-session" | "deny" | "deny-reason" | "change-level";

export interface GateItem {
	value: GateChoice;
	label: string;
	description?: string;
}

/** What pi-guru needs to render a gate: enough of the extension context to show a dialog. */
export type GateContext = Pick<ExtensionContext, "mode" | "ui">;

/** Produces the next explanation, one level deeper each call. Present ⇒ Explain is offered. */
export type Explainer = () => Promise<ExplainStep>;

/** A description of the change call the gate is deciding. */
export interface GateRequest {
	/** e.g. "Run this command?" or "Write this file?" */
	title: string;
	/** The command, or the path plus a short diff/content preview. */
	detail: string;
	/** Judge verdict slot: rendered above the explanation when present. */
	header?: string;
}

/** How the gate should behave for this call, beyond the request itself. */
export interface GateOptions {
	/** Present ⇒ offer Explain as first choice and default. Absent when off / no model. */
	explainer?: Explainer;
	/** The level the first explanation is given at — shown as the Explain description. */
	startLevel?: SpokenLevel;
	/** The current session gate level — marks "(current)" in the second menu. */
	gateLevel?: GateLevel;
}

/** The person's decision, normalized for the pipeline. */
export type GateResult =
	| { decision: "approve" }
	| { decision: "approve-session" }
	| { decision: "deny"; reason: string }
	/** The person chose a new session gate level from the gate's second menu. */
	| { decision: "change-level"; level: GateLevel };

const BASE_ITEMS: GateItem[] = [
	{ value: "approve", label: "Approve", description: "Run this once" },
	{ value: "approve-session", label: "Approve for this session", description: "Remember and stop asking" },
	{ value: "deny", label: "Deny", description: "Don't run it" },
	{ value: "deny-reason", label: "Deny with a reason", description: "Tell the agent why" },
];

/** The gate's last choice: opens the second menu. Below Deny, never the default. */
const CHANGE_LEVEL_ITEM: GateItem = {
	value: "change-level",
	label: "Change how pi-guru asks…",
	description: "Let the judge approve, or stop asking, this session",
};

/**
 * The gate choices. With `explain` true, Explain is prepended as the first choice (issue
 * #2); otherwise the four base choices stand, with Approve first. With `changeLevel`
 * true, "Change how pi-guru asks…" is appended as the last choice.
 */
export function gateItems(explain = false, startLevel?: SpokenLevel, changeLevel = false): GateItem[] {
	const head: GateItem[] = explain
		? [
				{
					value: "explain",
					label: "Explain",
					description: startLevel ? `Plain-language account (${startLevel})` : "Plain-language account",
				},
			]
		: [];
	const tail: GateItem[] = changeLevel ? [CHANGE_LEVEL_ITEM] : [];
	return [...head, ...BASE_ITEMS, ...tail];
}

/** Index the default cursor should sit on: Explain before any explanation, else Approve. */
function defaultIndex(items: GateItem[], explained: boolean): number {
	const wantExplain = !explained && items[0]?.value === "explain";
	if (wantExplain) return 0;
	const i = items.findIndex((it) => it.value === "approve");
	return i === -1 ? 0 : i;
}

const DEFAULT_DENY_REASON = "pi-guru: denied at the gate";

/** Present the gate and return the normalized decision. Cancelling counts as Deny (fail-safe). */
export async function presentGate(
	ctx: GateContext,
	request: GateRequest,
	opts: GateOptions = {},
): Promise<GateResult> {
	const items = gateItems(Boolean(opts.explainer), opts.startLevel, true);
	// Loop so the second menu's "Back"/cancel — and an unconfirmed "stop asking" — return to the
	// gate rather than deciding the call.
	while (true) {
		const choice =
			ctx.mode === "tui"
				? await presentCustom(ctx, request, items, opts.explainer)
				: await presentSelect(ctx, request, items, opts.explainer);
		if (choice !== "change-level") return interpret(ctx, choice);

		const level = await presentLevelMenu(ctx, opts.gateLevel ?? "ask");
		if (level === undefined || level === "back") continue; // back to the gate
		if (level === "off" && !(await confirmStopAsking(ctx))) continue; // off needs the typed phrase
		return { decision: "change-level", level };
	}
}

/** The second menu's items, marking the current session level. */
function levelItems(current: GateLevel): { value: GateLevel | "back"; label: string }[] {
	const mark = (level: GateLevel, base: string) => (level === current ? `${base} (current)` : base);
	return [
		{ value: "ask", label: mark("ask", "Keep asking") },
		{ value: "auto-low", label: mark("auto-low", "Let the judge approve low-risk changes this session") },
		{ value: "auto-medium", label: mark("auto-medium", "Let the judge approve low and medium this session") },
		{ value: "off", label: mark("off", "Stop asking this session (hard denies stay)") },
		{ value: "back", label: "Back" },
	];
}

/**
 * The gate's second menu: "Change how pi-guru asks…". A `ctx.ui.custom` SelectList in
 * TUI so it renders like the gate; a `ctx.ui.select` fallback elsewhere. Returns the chosen gate
 * level, or "back"/undefined to return to the gate.
 */
async function presentLevelMenu(
	ctx: GateContext,
	current: GateLevel,
): Promise<GateLevel | "back" | undefined> {
	const items = levelItems(current);
	const title = "Change how pi-guru asks…";
	if (ctx.mode !== "tui") {
		const picked = await ctx.ui.select(
			title,
			items.map((it) => it.label),
		);
		if (picked === undefined) return undefined;
		return items.find((it) => it.label === picked)?.value ?? "back";
	}
	const selectItems: SelectItem[] = items.map((it) => ({ value: it.value, label: it.label }));
	const result = await ctx.ui.custom<GateLevel | "back">((tui, theme, _kb, done) => {
		const list = new SelectList(selectItems, Math.min(selectItems.length, 10), {
			selectedPrefix: (t) => theme.fg("accent", t),
			selectedText: (t) => theme.fg("accent", t),
			description: (t) => theme.fg("muted", t),
			scrollInfo: (t) => theme.fg("dim", t),
			noMatch: (t) => theme.fg("warning", t),
		});
		list.onSelect = (item) => done(item.value as GateLevel | "back");
		list.onCancel = () => done("back"); // esc = back to the gate
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
		container.addChild(list);
		container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc back"), 1, 0));
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		return {
			render: (w: number) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				list.handleInput(data);
				tui.requestRender();
			},
		};
	});
	return result ?? "back";
}

/**
 * The typed confirmation the `off` level requires before it takes effect: the person
 * must type `stop asking`. Shared by the gate's second menu and the `/gate level off` command.
 */
export async function confirmStopAsking(ctx: GateContext): Promise<boolean> {
	const typed = await ctx.ui.input("Type 'stop asking' to stop pi-guru asking this session", "stop asking");
	return typed?.trim().toLowerCase() === "stop asking";
}

/** TUI path: a re-rendering component with the Explain loop and a preselected default. */
async function presentCustom(
	ctx: GateContext,
	request: GateRequest,
	items: GateItem[],
	explainer?: Explainer,
): Promise<GateChoice> {
	const selectItems: SelectItem[] = items.map((it) => ({
		value: it.value,
		label: it.label,
		description: it.description,
	}));
	const result = await ctx.ui.custom<GateChoice>((tui, theme, _kb, done) => {
		const mdTheme = getMarkdownTheme();
		let explanation: { markdown: string; level: SpokenLevel } | null = null;
		let busy = false;
		let container = new Container();

		const onSelect = async (value: GateChoice) => {
			if (value !== "explain") {
				done(value);
				return;
			}
			if (busy || !explainer) return;
			busy = true;
			rebuild();
			tui.requestRender();
			const step = await explainer();
			busy = false;
			if (step.ok) {
				explanation = { markdown: step.markdown, level: step.level };
			} else {
				ctx.ui.notify(`pi-guru: Explain unavailable (${step.message})`, "warning");
			}
			rebuild();
			tui.requestRender();
		};

		function rebuild(): void {
			const next = new Container();
			next.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			if (request.header) next.addChild(new Text(theme.fg("warning", request.header), 1, 0));
			next.addChild(new Text(theme.fg("accent", theme.bold(request.title)), 1, 0));
			next.addChild(new Text(theme.fg("muted", request.detail), 1, 0));
			if (explanation) {
				next.addChild(new Text(theme.fg("dim", `Explanation (${explanation.level}):`), 1, 0));
				next.addChild(new Markdown(explanation.markdown, 1, 0, mdTheme));
			}
			if (busy) next.addChild(new Text(theme.fg("dim", "Explaining…"), 1, 0));
			const list = new SelectList(selectItems, Math.min(selectItems.length, 10), {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			});
			list.setSelectedIndex(defaultIndex(items, explanation !== null));
			list.onSelect = (item) => onSelect(item.value as GateChoice);
			list.onCancel = () => done("deny"); // cancel = deny (fail-safe)
			next.addChild(list);
			next.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc deny"), 1, 0));
			next.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			currentList = list;
			container = next;
		}

		let currentList: SelectList;
		rebuild();
		return {
			render: (w: number) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				currentList.handleInput(data);
				tui.requestRender();
			},
		};
	});
	return result ?? "deny";
}

/** Fallback path: a `ctx.ui.select` loop; explanations are shown in the dialog text. */
async function presentSelect(
	ctx: GateContext,
	request: GateRequest,
	items: GateItem[],
	explainer?: Explainer,
): Promise<GateChoice> {
	const labels = items.map((it) => it.label);
	let explanation: string | null = null;
	while (true) {
		const parts = [
			request.title,
			"",
			...(request.header ? [request.header, ""] : []),
			...(explanation ? [explanation, ""] : []),
			`  ${request.detail}`,
		];
		const picked = await ctx.ui.select(parts.join("\n"), labels);
		if (picked === undefined) return "deny"; // cancel/timeout = deny (fail-safe)
		const value = items.find((it) => it.label === picked)?.value ?? "deny";
		if (value !== "explain") return value;
		if (!explainer) return "deny";
		const step = await explainer();
		if (step.ok) explanation = `Explanation (${step.level}):\n${step.markdown}`;
		else ctx.ui.notify(`pi-guru: Explain unavailable (${step.message})`, "warning");
	}
}

/** Turn a choice into a result, asking for a reason when the person denies with one. */
async function interpret(ctx: GateContext, choice: GateChoice): Promise<GateResult> {
	switch (choice) {
		case "approve":
			return { decision: "approve" };
		case "approve-session":
			return { decision: "approve-session" };
		case "deny-reason": {
			const reason = await ctx.ui.input("Why deny this?", "Reason the agent will see");
			return { decision: "deny", reason: reason?.trim() ? `pi-guru: ${reason.trim()}` : DEFAULT_DENY_REASON };
		}
		default:
			// "deny" and the never-returned "explain" both fall through to deny here.
			return { decision: "deny", reason: DEFAULT_DENY_REASON };
	}
}
