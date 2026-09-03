/**
 * The guarded plain-language reading of a benchmark summary (the design notes, plan "Report", plan-review
 * finding 11).
 *
 * A fluent paragraph over per-source N in the tens can launder noise into confident prose, so this
 * module is deliberately narrow. It reduces a summary to the numbers ONLY — each rate with its
 * denominator N and a Wilson 95% interval — and hands them to the session model under a prompt (data
 * in `src/levels.ts`) that forbids comparative or causal claims the numbers do not contain. The
 * reading is suppressed entirely when any per-source sample is below `READING_N_FLOOR`, degrades to a
 * one-line note when there is no session model, and is always labelled "generated". Everything here
 * is pure except `generateReading`, which takes an injected `Completer` so it is tested without a
 * network.
 */

import { type ExplanationLevel, READING_PROMPTS, type SpokenLevel } from "../levels.ts";
import { type Completer, completionText, totalTokens, userMessage } from "../model.ts";
import type { RunSummary } from "./run-result.ts";

/** A Wilson score interval at 95% — a proportion's plausible range given its denominator. */
export interface Interval {
	lo: number;
	hi: number;
}

/** One rate the reading is given: a point estimate, its denominator N, and its 95% interval. */
export interface ReadingStat {
	label: string;
	rate: number;
	n: number;
	interval: Interval;
}

/** The numbers-only view of a summary handed to the model — no prose, no source labels beyond names. */
export interface ReadingFacts {
	title: string;
	stats: ReadingStat[];
	/** The smallest per-source sample count; the suppression floor is applied to this. */
	minN: number;
}

/** Below this per-source sample count the reading is suppressed rather than written (finding 11). */
export const READING_N_FLOOR = 20;

/** The z-value for a 95% two-sided normal interval. */
const Z95 = 1.959963984540054;

/**
 * The Wilson score interval for `successes` out of `n` at 95%. Unlike the naive normal interval it
 * stays inside [0, 1] and behaves at the extremes, which is exactly where small-N benchmark rates
 * live. Returns null when `n` is zero (an undefined rate).
 */
export function wilson95(successes: number, n: number): Interval | null {
	if (n <= 0) return null;
	const p = successes / n;
	const z2 = Z95 * Z95;
	const denom = 1 + z2 / n;
	const center = (p + z2 / (2 * n)) / denom;
	const margin = (Z95 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
	return { lo: Math.max(0, center - margin), hi: Math.min(1, center + margin) };
}

/** Build a stat from a count and denominator, skipped by the caller when the denominator is zero. */
function stat(label: string, successes: number, n: number): ReadingStat | null {
	const interval = wilson95(successes, n);
	if (interval === null) return null;
	return { label, rate: successes / n, n, interval };
}

/**
 * Reduce one accuracy run to its rates. Each source contributes let-through (≤low, ≤medium) over its
 * harmful records and benign-blocked over its benign records, using the **per-record majority** rates
 * so correlated passes are not treated as independent N. `minN` is the smallest
 * per-source record count, which drives suppression.
 */
export function readingFactsForRun(summary: RunSummary): ReadingFacts {
	const stats: ReadingStat[] = [];
	let minN = Number.POSITIVE_INFINITY;
	for (const s of summary.perSource) {
		minN = Math.min(minN, s.n);
		const low = s.majorityLetThroughLow;
		const med = s.majorityLetThroughMedium;
		const benign = s.majorityBenignBlocked;
		const hN = s.majorityHarmfulN;
		const bN = s.majorityBenignN;
		if (low !== null) push(stats, `${s.source} let-through ≤low`, Math.round(low * hN), hN);
		if (med !== null) push(stats, `${s.source} let-through ≤medium`, Math.round(med * hN), hN);
		if (benign !== null) push(stats, `${s.source} benign-blocked`, Math.round(benign * bN), bN);
	}
	return { title: `run ${summary.run}`, stats, minN: Number.isFinite(minN) ? minN : 0 };
}

/**
 * Reduce a comparison (several runs, each per source) to its rates, one stat per (run, source, rate).
 * The prompt's "do not call one model better unless the intervals are disjoint" rule is what keeps a
 * cross-model reading honest.
 */
export function readingFactsForCompare(summaries: RunSummary[]): ReadingFacts {
	const stats: ReadingStat[] = [];
	let minN = Number.POSITIVE_INFINITY;
	for (const summary of summaries) {
		const model = `${summary.model.provider}/${summary.model.id}`;
		for (const s of summary.perSource) {
			minN = Math.min(minN, s.n);
			if (s.majorityLetThroughMedium !== null) {
				push(
					stats,
					`${model} · ${s.source} let-through ≤medium`,
					Math.round(s.majorityLetThroughMedium * s.majorityHarmfulN),
					s.majorityHarmfulN,
				);
			}
			if (s.majorityBenignBlocked !== null) {
				push(
					stats,
					`${model} · ${s.source} benign-blocked`,
					Math.round(s.majorityBenignBlocked * s.majorityBenignN),
					s.majorityBenignN,
				);
			}
		}
	}
	return { title: "comparison across runs", stats, minN: Number.isFinite(minN) ? minN : 0 };
}

function push(stats: ReadingStat[], label: string, successes: number, n: number): void {
	const s = stat(label, successes, n);
	if (s) stats.push(s);
}

/** Format one rate as `label: 42.0% (n=19, 95% CI 23.1–63.7%)` — the model sees only this. */
function formatStat(s: ReadingStat): string {
	const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
	return `- ${s.label}: ${pct(s.rate)} (n=${s.n}, 95% CI ${pct(s.interval.lo)}–${pct(s.interval.hi)})`;
}

/** The user message handed to the model: the title and the numbers, nothing else. */
export function formatReadingFacts(facts: ReadingFacts): string {
	return [`Summary of the ${facts.title}. Read these numbers only:`, "", ...facts.stats.map(formatStat)].join(
		"\n",
	);
}

/** The outcome of asking for a reading: generated prose, suppressed by the floor, or unavailable. */
export type ReadingResult =
	| { kind: "reading"; markdown: string; tokens: number }
	| { kind: "suppressed"; note: string }
	| { kind: "unavailable"; note: string };

/** Options for `generateReading`. `complete` is null when there is no session model. */
export interface ReadingOptions {
	level: SpokenLevel;
	facts: ReadingFacts;
	complete: Completer | null;
}

/**
 * Ask the session model for a reading of `facts`, under the level's prompt. Suppressed when any
 * per-source sample is below the floor; unavailable when there is no model or the call fails
 * (including a timeout). Never throws.
 */
export async function generateReading(opts: ReadingOptions): Promise<ReadingResult> {
	if (opts.facts.stats.length === 0) {
		return { kind: "suppressed", note: "Plain-language reading suppressed: no scored rates to read." };
	}
	if (opts.facts.minN < READING_N_FLOOR) {
		return {
			kind: "suppressed",
			note: `Plain-language reading suppressed: a source has only ${opts.facts.minN} records (< ${READING_N_FLOOR}); the numbers are too noisy to summarise in prose.`,
		};
	}
	if (!opts.complete) {
		return { kind: "unavailable", note: "Plain-language reading unavailable: no session model." };
	}
	try {
		const message = await opts.complete({
			systemPrompt: READING_PROMPTS[opts.level],
			messages: userMessage(formatReadingFacts(opts.facts)),
		});
		const text = completionText(message);
		if (!text) return { kind: "unavailable", note: "Plain-language reading unavailable: empty model reply." };
		return { kind: "reading", markdown: text, tokens: totalTokens(message.usage) };
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		return {
			kind: "unavailable",
			note: `Plain-language reading unavailable: ${reason || "model call failed"}.`,
		};
	}
}

/** Narrow an explanation level to a spoken one; `off` (no reading) yields null. */
export function spokenOrNull(level: ExplanationLevel): SpokenLevel | null {
	return level === "off" ? null : level;
}

/**
 * The reading as a Markdown block for the `<run>.md` file and the result entry. A generated reading
 * is fenced under a "generated" heading; a suppressed/unavailable outcome is the one-line note.
 */
export function formatReadingBlock(result: ReadingResult): string {
	if (result.kind === "reading") {
		return ["## Plain-language reading (generated)", "", result.markdown].join("\n");
	}
	return ["## Plain-language reading", "", `_${result.note}_`].join("\n");
}
