/**
 * The accuracy runner.
 *
 * Loads the enabled sources through the slice-1 loader, draws the deterministic per-source sample,
 * and judges each record through the *production* path (`judgeRecord` → `runJudge` →
 * `buildJudgeMessages` → `parseVerdict`) — the bench re-implements none of the prompt, layout, or
 * parser. Every record is checkpointed the instant it is judged: appended to the JSONL and the
 * derived summary rewritten, so a crash or an Esc leaves a complete, up-to-date result on disk.
 *
 * The runner owns an `AbortController` because `ctx.signal` is undefined outside an agent turn
 * (finding 2); each model call is bounded by `AbortSignal.any([runner, timeout])`. Sequential by
 * default; `--concurrency` fans out but never persists a call that was aborted mid-flight, so
 * `--resume` re-runs exactly the unfinished records (finding 7). The filesystem lives behind a
 * `RunSink` so the whole runner is unit-tested with an in-memory sink and a fake completer.
 */

import type { JudgeLayout, LayoutContext } from "../judge.ts";
import type { JudgePromptVersion } from "../judge-prompt.ts";
import type { ExplanationLevel } from "../levels.ts";
import type { Completer, Usage } from "../model.ts";
import { entriesToMessages, type SessionEntryLike } from "../transcript.ts";
import { SYNTHETIC_AGENT_SYSTEM_PROMPT } from "./cache-session.ts";
import { type LoadOptions, type LoadResult, loadSources } from "./loader.ts";
import { judgeRecord } from "./run-record.ts";
import {
	computeSummary,
	type RunMeta,
	type RunRecord,
	type RunSummary,
	type SourceFailedLine,
} from "./run-result.ts";
import { sample } from "./sample.ts";
import type { BenchRecord } from "./schema.ts";

/** Where a run's results are persisted. A file-backed impl lives in `results.ts`; tests use memory. */
export interface RunSink {
	/** Record a source that failed to load (JSONL `source-failed` line). */
	appendSourceFailed(line: SourceFailedLine): Promise<void> | void;
	/** Append one judged record to the JSONL. */
	appendRecord(record: RunRecord): Promise<void> | void;
	/** Rewrite the derived summary (called after every record). */
	writeSummary(summary: RunSummary): Promise<void> | void;
	/** All records appended so far (including resumed ones) — the summary is recomputed from these. */
	allRecords(): RunRecord[];
	/** All source failures recorded so far. */
	sourceFailures(): { source: string; reason: string }[];
	/** `${recordId}#${pass}` keys already present — `--resume` skips these. */
	doneKeys(): Set<string>;
}

/** The resume/skip key for one pass of one record. */
export function passKey(recordId: string, pass: number): string {
	return `${recordId}#${pass}`;
}

/** Progress emitted after each record, for the overlay (TUI) or progress lines (other modes). */
export interface RunProgress {
	done: number;
	total: number;
	lastRecord: RunRecord;
	summary: RunSummary;
}

export interface RunnerOptions {
	meta: RunMeta;
	seed: string | number;
	limit?: number;
	concurrency?: number;
	/** The rationale level handed to the production judge; defaults to `technical`. */
	level?: ExplanationLevel;
	/** Which sources to load; forwarded to the loader (`sources`/`only`). */
	load?: Pick<LoadOptions, "sources" | "only">;
	/** The request layout to measure; defaults to `current` (production byte-identical). */
	layout?: JudgeLayout;
	/** The judge prompt version to measure; defaults to `v1` (the shipping text, the design notes). */
	promptVersion?: JudgePromptVersion;
	/** Fixed per-run nonce for `prefix-stable`'s transcript fence, so the request is deterministic. */
	sessionNonce?: string;
	/** Builds the completer for one call, given the combined runner+timeout signal. */
	makeCompleter: (signal: AbortSignal) => Completer;
	sink: RunSink;
	onProgress?: (progress: RunProgress) => void;
	/** Per-call timeout; defaults to 60 s, matching production. */
	perCallTimeoutMs?: number;
	/** Injectable for tests so no source ever hits the network. */
	loadSourcesFn?: (opts: LoadOptions) => Promise<LoadResult>;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** Cap on the raw model reply persisted on an unavailable record. */
const RAW_MAX = 2000;

/**
 * Reject as soon as `signal` aborts, otherwise settle with `promise`. The runner passes the per-call
 * timeout/abort signal to the transport, but a transport that ignores it would leave `await` pending
 * past the deadline (a call once ran 1058 s under `--timeout 900`). Racing the completion against the
 * signal makes the runner stop waiting at the deadline regardless — the underlying request may keep
 * running in the background, but the record is written as a timeout at ~the per-call limit.
 */
function raceAgainstSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(new Error("aborted"));
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(new Error("aborted"));
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(err) => {
				signal.removeEventListener("abort", onAbort);
				reject(err);
			},
		);
	});
}

/** One accuracy run. Construct, optionally wire `abort()` to an overlay, then `await run()`. */
export class BenchRunner {
	readonly controller = new AbortController();
	private readonly opts: RunnerOptions;
	private readonly level: ExplanationLevel;
	private readonly timeoutMs: number;
	private readonly passes: number;
	private readonly layout: JudgeLayout;
	private readonly promptVersion: JudgePromptVersion;
	/** Whether the deterministic facts block + floors are applied, from the run meta. */
	private readonly facts: boolean;
	/** Serializes checkpoint writes so concurrent workers never race the summary file. */
	private writeChain: Promise<void> = Promise.resolve();
	private done = 0;
	/**
	 * Keys this runner has claimed — in-flight now or already committed by it. Consulted together
	 * with the sink's LIVE `doneKeys()` before every `judgeOne`, so no `(recordId, pass)` is ever
	 * judged twice: not a duplicate id in the sample (all rogue rows once collapsed to one id), not
	 * a second worker, and not a second dispatch that resumed the same run. A start-of-run
	 * snapshot was not enough — it never saw work another dispatch committed after the run began.
	 */
	private readonly claimed = new Set<string>();

	constructor(opts: RunnerOptions) {
		this.opts = opts;
		this.level = opts.level ?? "technical";
		this.timeoutMs = opts.perCallTimeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.passes = Math.max(1, opts.meta.passes);
		this.layout = opts.layout ?? "current";
		this.promptVersion = opts.promptVersion ?? "v1";
		this.facts = opts.meta.facts ?? false;
	}

	/** Abort the run — no new records start and in-flight results are discarded (not persisted). */
	abort(): void {
		this.controller.abort();
	}

	get signal(): AbortSignal {
		return this.controller.signal;
	}

	async run(): Promise<RunSummary> {
		const loadFn = this.opts.loadSourcesFn ?? loadSources;
		const { records: loaded, events } = await loadFn({ ...this.opts.load, signal: this.controller.signal });

		for (const event of events) {
			if (event.type === "source-failed") {
				await this.commitWrite(async () => {
					await this.opts.sink.appendSourceFailed(event);
				});
			}
		}

		const sampled = sample(loaded, { seed: this.opts.seed, limit: this.opts.limit });
		const alreadyDone = this.opts.sink.doneKeys();
		// Total work is one line per (record, pass). A record is "to do" while any of its passes is
		// missing; each worker runs a record's remaining passes consecutively so the prefix stays
		// resident. `done` counts passes already checkpointed by a prior run.
		const passList = Array.from({ length: this.passes }, (_, i) => i + 1);
		const total = sampled.length * this.passes;
		this.done = sampled.reduce(
			(n, r) => n + passList.filter((p) => alreadyDone.has(passKey(r.id, p))).length,
			0,
		);
		const todo = sampled.filter((r) => passList.some((p) => !alreadyDone.has(passKey(r.id, p))));

		// The JSONL is created (opened) by the sink before this call; write the summary once up front
		// so an immediate crash still leaves a summary reflecting the source failures and resumed set.
		await this.commitWrite(async () => this.writeSummaryNow());

		const concurrency = Math.max(1, this.opts.concurrency ?? 1);
		const queue = [...todo];
		const worker = async () => {
			while (!this.controller.signal.aborted) {
				const record = queue.shift();
				if (!record) return;
				// All passes for this record run consecutively before the next record is taken.
				for (const pass of passList) {
					if (this.controller.signal.aborted) return;
					// Guard against judging one (recordId, pass) twice — dynamically, right before the
					// call, not from a stale start-of-run snapshot. A key is skipped if it is already
					// on disk (the sink's LIVE done set — includes a concurrent dispatch's commits) or
					// claimed in-flight by this runner.
					const key = passKey(record.id, pass);
					if (this.claimed.has(key) || this.opts.sink.doneKeys().has(key)) continue;
					this.claimed.add(key); // claim before awaiting, so no second worker/pass takes it
					const result = await this.judgeOne(record, pass);
					if (this.controller.signal.aborted) {
						this.claimed.delete(key); // aborted mid-flight → release so a resume re-runs it
						return;
					}
					await this.commitRecord(result, total);
				}
			}
		};
		await Promise.all(Array.from({ length: concurrency }, worker));

		// Stamp completion (or leave it null when aborted, so a resume can tell it was interrupted).
		if (!this.controller.signal.aborted) this.opts.meta.finished = new Date().toISOString();
		let summary: RunSummary = this.buildSummary();
		await this.commitWrite(async () => {
			summary = this.buildSummary();
			await this.opts.sink.writeSummary(summary);
		});
		return summary;
	}

	/** The per-record layout context, built exactly as the cache runner does but over the record's
	 * own transcript (accuracy runs use independent records, not one growing session). */
	private layoutContext(record: BenchRecord): LayoutContext {
		switch (this.layout) {
			case "current":
				return {};
			case "prefix-stable":
				return { sessionNonce: this.opts.sessionNonce };
			case "shared-prefix":
				return {
					agentSystemPrompt: SYNTHETIC_AGENT_SYSTEM_PROMPT,
					agentMessages: entriesToMessages(
						record.transcriptEntries as unknown as SessionEntryLike[],
					) as LayoutContext["agentMessages"],
				};
		}
	}

	/** Judge one pass of one record through the production path, timing it and capturing usage. */
	private async judgeOne(record: BenchRecord, pass: number): Promise<RunRecord> {
		const timeout = AbortSignal.timeout(this.timeoutMs);
		const signal = AbortSignal.any([this.controller.signal, timeout]);
		const completer = this.opts.makeCompleter(signal);
		let usage: Usage | undefined;
		const timed: Completer = async (context) => {
			// Race against the combined signal so a transport that ignores the abort cannot outlive the
			// per-call timeout. The completer still receives the signal, so a cooperative
			// transport cancels its request; the race only bounds how long the runner waits.
			const message = await raceAgainstSignal(completer(context), signal);
			usage = message.usage;
			return message;
		};
		const started = performance.now();
		const result = await judgeRecord(
			record,
			timed,
			this.level,
			this.layout,
			this.layoutContext(record),
			this.promptVersion,
			this.facts,
		);
		const latencyMs = Math.round(performance.now() - started);
		// Normalise the unavailable reason to `timeout` by signal, not by string-matching the thrown
		// message: the per-call timeout fired and the runner-wide abort did not. The report counts
		// timeouts apart so a busy shared box is not misread as a bad model.
		const error =
			!result.available && timeout.aborted && !this.controller.signal.aborted ? "timeout" : result.reason;
		return {
			recordId: record.id,
			pass,
			source: record.source,
			sourceVersion: record.sourceVersion,
			expected: record.expected,
			authoredRisk: record.authoredRisk,
			kind: record.kind,
			category: record.category,
			available: result.available,
			risk: result.risk,
			rationale: result.rationale,
			latencyMs,
			promptTokens: usage ? usage.input : null,
			cachedTokens: usage ? usage.cacheRead : null,
			error,
			// The deterministic floor this record's facts imposed, and whether it raised the verdict .
			floor: result.floor,
			raised: result.raised,
			// Keep the un-normalised reason and the model's raw reply only on unavailable records, so
			// an unparseable/refused/empty verdict can be diagnosed after the fact.
			...(result.available
				? {}
				: { reason: result.reason, raw: result.raw ? result.raw.slice(0, RAW_MAX) : null }),
		};
	}

	/** Append one record, rewrite the summary, and emit progress — all serialized. */
	private async commitRecord(record: RunRecord, total: number): Promise<void> {
		await this.commitWrite(async () => {
			await this.opts.sink.appendRecord(record);
			this.done++;
			const summary = this.buildSummary();
			await this.opts.sink.writeSummary(summary);
			this.opts.onProgress?.({ done: this.done, total, lastRecord: record, summary });
		});
	}

	private async writeSummaryNow(): Promise<void> {
		await this.opts.sink.writeSummary(this.buildSummary());
	}

	private buildSummary(): RunSummary {
		return computeSummary(this.opts.meta, this.opts.sink.allRecords(), this.opts.sink.sourceFailures());
	}

	/** Chain a filesystem write onto the serialized tail so concurrent workers never overlap. */
	private commitWrite(task: () => Promise<void>): Promise<void> {
		this.writeChain = this.writeChain.then(task);
		return this.writeChain;
	}
}
