/**
 * The synthetic-session cache benchmark.
 *
 * Replays the fixed synthetic session (`cache-session.ts`) as ONE growing transcript, judging each
 * change call in turn through the production `runJudge` with a chosen request layout. It runs each
 * selected layout for two passes back-to-back: the second pass re-sends byte-identical prefixes, so
 * an endpoint with prefix caching serves it from resident KV blocks. Per call it records
 * promptTokens, cachedTokens (when the endpoint reports it), latency, and the verdict.
 *
 * The primary cache signal is `cached_tokens` (truth). Some endpoints do not report it, so the
 * runner treats it as optional and falls back to the prefill-latency ratio (pass 1 vs pass 2) as an
 * advisory signal only — on a shared GPU box, latency alone cannot separate a cache miss from a busy
 * engine (finding 9). Every
 * record is checkpointed to disk as it completes (compute-discipline: save incrementally). Sequential
 * only; the runner owns an `AbortController` because `ctx.signal` is undefined outside a turn.
 */

import { type JudgeLayout, runJudge } from "../judge.ts";
import type { ExplanationLevel } from "../levels.ts";
import type { Completer, Usage } from "../model.ts";
import type { SyntheticSession } from "./cache-session.ts";
import type { RunRisk } from "./run-result.ts";

/** One judged call in one pass under one layout. */
export interface CacheRecord {
	layout: JudgeLayout;
	/** 1 (cold) or 2 (repeat — the pass that should hit the cache for the stable layouts). */
	pass: number;
	/** 1-based call index in the synthetic session. */
	call: number;
	promptTokens: number | null;
	/** Endpoint-reported cache reuse (`usage.cacheRead`), or null when unreported. */
	cachedTokens: number | null;
	latencyMs: number;
	available: boolean;
	risk: RunRisk | null;
	error: string | null;
}

/** Cache-run identity and parameters, persisted in the summary. */
export interface CacheMeta {
	run: string;
	model: { provider: string; id: string };
	layouts: JudgeLayout[];
	passes: number;
	calls: number;
	/** Whether the deterministic facts block is sent with each judged call. */
	facts: boolean;
	/** Tokens of deterministic filler padding the synthetic session's early transcript. */
	padTokens?: number;
	/** The per-call timeout in ms this run used. */
	timeoutMs: number;
	started: string;
	finished: string | null;
}

/** Where a cache run's records and summary are persisted. Memory in tests, files in production. */
export interface CacheSink {
	appendRecord(record: CacheRecord): void | Promise<void>;
	writeSummary(summary: CacheSummary): void | Promise<void>;
	allRecords(): CacheRecord[];
}

/** Per-layout rollup: cold vs repeat prefill latency, cached-token truth, prompt size. */
export interface LayoutCacheSummary {
	layout: JudgeLayout;
	meanLatencyPass1: number | null;
	meanLatencyPass2: number | null;
	/** pass1/pass2 mean latency — advisory only; > 1 hints the repeat pass hit warm KV blocks. */
	latencyRatio: number | null;
	/**
	 * Whether any call under this layout observed a NONZERO cached-token count. pi's `usage.cacheRead`
	 * is always a number (0 when the endpoint reports nothing), so a nonzero value is the only honest
	 * evidence the endpoint reports cache reuse at all; all-zero means fall back to the latency ratio.
	 */
	cachedReported: boolean;
	/** Mean cached tokens on the repeat pass, when reported. */
	meanCachedTokensPass2: number | null;
	meanPromptTokens: number | null;
}

/** Verdict agreement across the selected layouts, computed from pass 1. */
export interface VerdictAgreement {
	calls: number;
	agreedCalls: number;
	rate: number | null;
}

/** The full cache-run summary written to `cache-<run>.summary.json`. */
export interface CacheSummary extends CacheMeta {
	perLayout: LayoutCacheSummary[];
	/** Null when fewer than two layouts ran (nothing to compare). */
	verdictAgreement: VerdictAgreement | null;
}

/** Progress emitted after each judged call. */
export interface CacheProgress {
	done: number;
	total: number;
	last: CacheRecord;
}

export interface CacheRunnerOptions {
	meta: CacheMeta;
	layouts: JudgeLayout[];
	passes: number;
	session: SyntheticSession;
	/** Fixed per run so the fenced-transcript prefix is byte-stable across calls and passes. */
	sessionNonce: string;
	makeCompleter: (signal: AbortSignal) => Completer;
	sink: CacheSink;
	onProgress?: (progress: CacheProgress) => void;
	perCallTimeoutMs?: number;
	level?: ExplanationLevel;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** One cache run. Construct, optionally wire `abort()` to an overlay, then `await run()`. */
export class CacheRunner {
	readonly controller = new AbortController();
	private readonly opts: CacheRunnerOptions;
	private readonly level: ExplanationLevel;
	private readonly timeoutMs: number;
	private done = 0;

	constructor(opts: CacheRunnerOptions) {
		this.opts = opts;
		this.level = opts.level ?? "technical";
		this.timeoutMs = opts.perCallTimeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	abort(): void {
		this.controller.abort();
	}
	get signal(): AbortSignal {
		return this.controller.signal;
	}

	async run(): Promise<CacheSummary> {
		const { layouts, passes, session, sink } = this.opts;
		const total = layouts.length * passes * session.steps.length;
		// Sequential by design: two models never share the box, and one call's warm KV blocks are what
		// the next call reuses — concurrency would corrupt both the residency and the timing.
		for (const layout of layouts) {
			for (let pass = 1; pass <= passes; pass++) {
				for (const step of session.steps) {
					if (this.controller.signal.aborted) return this.finish(total, true);
					const record = await this.judgeOne(layout, pass, step.call, step);
					if (this.controller.signal.aborted) return this.finish(total, true);
					await sink.appendRecord(record);
					this.done++;
					const summary = this.buildSummary(false);
					await sink.writeSummary(summary);
					this.opts.onProgress?.({ done: this.done, total, last: record });
				}
			}
		}
		return this.finish(total, false);
	}

	private async finish(_total: number, aborted: boolean): Promise<CacheSummary> {
		if (!aborted) this.opts.meta.finished = new Date().toISOString();
		const summary = this.buildSummary(!aborted);
		await this.opts.sink.writeSummary(summary);
		return summary;
	}

	/** Judge one step under one layout, timing it and capturing usage. Never throws. */
	private async judgeOne(
		layout: JudgeLayout,
		pass: number,
		call: number,
		step: SyntheticSession["steps"][number],
	): Promise<CacheRecord> {
		const timeout = AbortSignal.timeout(this.timeoutMs);
		const signal = AbortSignal.any([this.controller.signal, timeout]);
		const completer = this.opts.makeCompleter(signal);
		let usage: Usage | undefined;
		const timed: Completer = async (context) => {
			const message = await completer(context);
			usage = message.usage;
			return message;
		};
		const started = performance.now();
		const outcome = await runJudge({
			level: this.level,
			subject: step.subject,
			transcript: step.transcript,
			complete: timed,
			layout,
			layoutCtx: {
				sessionNonce: this.opts.sessionNonce,
				agentSystemPrompt: this.opts.session.agentSystemPrompt,
				agentMessages: step.agentMessages,
			},
			// Send the precomputed facts block only when the cache run has `--facts on`.
			factsBlock: this.opts.meta.facts ? step.factsBlock : undefined,
		});
		const latencyMs = Math.round(performance.now() - started);
		return {
			layout,
			pass,
			call,
			promptTokens: usage ? usage.input : null,
			cachedTokens: usage ? usage.cacheRead : null,
			latencyMs,
			available: outcome.available,
			risk: outcome.available ? outcome.verdict.risk : null,
			error: outcome.available
				? null
				: timeout.aborted && !this.controller.signal.aborted
					? "timeout"
					: outcome.reason,
		};
	}

	private buildSummary(finished: boolean): CacheSummary {
		if (finished && !this.opts.meta.finished) this.opts.meta.finished = new Date().toISOString();
		return computeCacheSummary(this.opts.meta, this.opts.sink.allRecords());
	}
}

/** Mean of a numeric list, or null when empty. */
function mean(values: number[]): number | null {
	if (values.length === 0) return null;
	return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Compute the derived cache summary from the flat records (pure). */
export function computeCacheSummary(meta: CacheMeta, records: CacheRecord[]): CacheSummary {
	const perLayout = meta.layouts.map((layout) => summarizeLayout(layout, records));
	const verdictAgreement = meta.layouts.length > 1 ? agreementAcrossLayouts(meta, records) : null;
	return { ...meta, perLayout, verdictAgreement };
}

function summarizeLayout(layout: JudgeLayout, records: CacheRecord[]): LayoutCacheSummary {
	const mine = records.filter((r) => r.layout === layout);
	const pass1 = mine.filter((r) => r.pass === 1);
	const pass2 = mine.filter((r) => r.pass === 2);
	const meanLatencyPass1 = mean(pass1.map((r) => r.latencyMs));
	const meanLatencyPass2 = mean(pass2.map((r) => r.latencyMs));
	const cached2 = pass2.filter((r) => r.cachedTokens !== null).map((r) => r.cachedTokens as number);
	return {
		layout,
		meanLatencyPass1,
		meanLatencyPass2,
		latencyRatio:
			meanLatencyPass1 !== null && meanLatencyPass2 !== null && meanLatencyPass2 > 0
				? meanLatencyPass1 / meanLatencyPass2
				: null,
		cachedReported: mine.some((r) => (r.cachedTokens ?? 0) > 0),
		meanCachedTokensPass2: mean(cached2),
		meanPromptTokens: mean(mine.filter((r) => r.promptTokens !== null).map((r) => r.promptTokens as number)),
	};
}

/** Fraction of calls where every selected layout produced the same pass-1 verdict. */
function agreementAcrossLayouts(meta: CacheMeta, records: CacheRecord[]): VerdictAgreement {
	let agreed = 0;
	let comparable = 0;
	for (let call = 1; call <= meta.calls; call++) {
		const verdicts = meta.layouts.map((layout) => {
			const r = records.find((x) => x.layout === layout && x.pass === 1 && x.call === call);
			return r?.available ? r.risk : undefined;
		});
		if (verdicts.some((v) => v === undefined)) continue; // a call not fully judged yet
		comparable++;
		if (verdicts.every((v) => v === verdicts[0])) agreed++;
	}
	return { calls: comparable, agreedCalls: agreed, rate: comparable === 0 ? null : agreed / comparable };
}
