/**
 * Persistence and reporting for the cache benchmark. Cache runs live under the same
 * results dir as accuracy runs (`resultsDir()`), with the file prefix `cache-`: `cache-<run>.jsonl`
 * (one record line per judged call, appended as it completes), `cache-<run>.summary.json` (the
 * derived summary, rewritten after every call), and `cache-<run>.md` (the same report as Markdown,
 * written beside the JSONL so results survive a dead UI). Nothing is written under the repo.
 */

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JudgeLayout } from "../judge.ts";
import type { CacheRecord, CacheSink, CacheSummary, LayoutCacheSummary } from "./cache-runner.ts";
import { resultsDir } from "./results.ts";

/** Keep an id segment usable as one filename part. */
function safe(segment: string): string {
	return segment.replace(/[^A-Za-z0-9._-]/g, "-");
}

/** A label for the selected layouts: `all` for the full set, else the layouts joined. */
export function layoutsLabel(layouts: JudgeLayout[]): string {
	return layouts.length >= 3 ? "all" : layouts.join("+");
}

/** Build a stable, filesystem-safe cache-run id: `cache-<stamp>-<provider>_<id>-<layouts>-facts<on|off>`. */
export function makeCacheRunId(
	model: { provider: string; id: string },
	layouts: JudgeLayout[],
	facts: boolean,
	when: Date = new Date(),
): string {
	const factsSeg = facts ? "factson" : "factsoff";
	return `cache-${safe(when.toISOString())}-${safe(model.provider)}_${safe(model.id)}-${safe(layoutsLabel(layouts))}-${factsSeg}`;
}

function jsonlPath(runId: string): string {
	return join(resultsDir(), `${runId}.jsonl`);
}
function summaryPath(runId: string): string {
	return join(resultsDir(), `${runId}.summary.json`);
}
function reportPath(runId: string): string {
	return join(resultsDir(), `${runId}.md`);
}

/** A file-backed `CacheSink`. The JSONL is created on construction, before the first model call. */
export class FileCacheSink implements CacheSink {
	private readonly records: CacheRecord[] = [];

	constructor(private readonly runId: string) {
		mkdirSync(resultsDir(), { recursive: true });
		if (!existsSync(jsonlPath(runId))) writeFileSync(jsonlPath(runId), "");
	}

	appendRecord(record: CacheRecord): void {
		this.records.push(record);
		appendFileSync(jsonlPath(this.runId), `${JSON.stringify({ type: "record", ...record })}\n`);
	}

	writeSummary(summary: CacheSummary): void {
		writeFileSync(summaryPath(this.runId), `${JSON.stringify(summary, null, 2)}\n`);
		writeFileSync(reportPath(this.runId), formatCacheReport(summary));
	}

	allRecords(): CacheRecord[] {
		return this.records;
	}
}

/** Format a latency in ms, or `—`. */
function ms(value: number | null): string {
	return value === null ? "—" : `${Math.round(value)} ms`;
}
/** Format a ratio to 2 decimals, or `—`. */
function ratio(value: number | null): string {
	return value === null ? "—" : `${value.toFixed(2)}×`;
}
/** Format a token mean rounded, or `—`. */
function tok(value: number | null): string {
	return value === null ? "—" : String(Math.round(value));
}

/** Render a Markdown table from a header row and body rows. */
function table(header: string[], rows: string[][]): string {
	const head = `| ${header.join(" | ")} |`;
	const sep = `| ${header.map(() => "---").join(" | ")} |`;
	const body = rows.map((r) => `| ${r.join(" | ")} |`).join("\n");
	return rows.length ? `${head}\n${sep}\n${body}` : `${head}\n${sep}`;
}

/** Whether any layout in the run carried endpoint-reported cached tokens. */
function anyCachedReported(summary: CacheSummary): boolean {
	return summary.perLayout.some((l) => l.cachedReported);
}

/** The cache-run report written to `cache-<run>.md` and shown by `cache`. */
export function formatCacheReport(summary: CacheSummary): string {
	const lines: string[] = [];
	const { provider, id } = summary.model;
	lines.push(`# judge-bench cache \`${summary.run}\``);
	lines.push("");
	lines.push(`- model: \`${provider}/${id}\``);
	lines.push(
		`- layouts: ${summary.layouts.join(", ")}  ·  passes: ${summary.passes}  ·  calls: ${summary.calls}  ·  pad-tokens: ${summary.padTokens ?? 0}`,
	);
	lines.push(
		`- started: ${summary.started || "?"}  ·  finished: ${summary.finished ?? "(in progress / interrupted)"}`,
	);
	lines.push("");
	lines.push("_Run on a shared GPU box, so read the latency figures below in a quiet window or not");
	lines.push("at all; a busy engine is indistinguishable from a cache miss._");
	lines.push("");

	const cached = anyCachedReported(summary);
	if (cached) {
		lines.push(
			"**Cache signal: `cached_tokens` reported by the endpoint — the primary, trustworthy signal.**",
		);
	} else {
		lines.push(
			"**Cache signal: `cached_tokens` NOT reported by this endpoint.** The cache claim cannot be made",
		);
		lines.push(
			"from truth; the pass-1 vs pass-2 prefill-latency ratio below is **advisory only** — a shared GPU box",
		);
		lines.push("cannot separate a cache miss from a busy engine on latency alone.");
	}
	lines.push("");

	lines.push(
		table(
			["layout", "pass1 mean", "pass2 mean", "ratio (adv.)", "cached_tokens (pass2)", "mean prompt tok"],
			summary.perLayout.map((l: LayoutCacheSummary) => [
				l.layout,
				ms(l.meanLatencyPass1),
				ms(l.meanLatencyPass2),
				ratio(l.latencyRatio),
				l.cachedReported ? tok(l.meanCachedTokensPass2) : "not reported",
				tok(l.meanPromptTokens),
			]),
		),
	);
	lines.push("");

	if (summary.verdictAgreement) {
		const a = summary.verdictAgreement;
		const rate = a.rate === null ? "—" : `${(a.rate * 100).toFixed(0)}%`;
		lines.push(
			`Verdict agreement across layouts (pass 1): ${a.agreedCalls}/${a.calls} calls agree (${rate}). ` +
				"A layout that changes the message shape should not change the verdict; disagreement is a cost.",
		);
	} else {
		lines.push("Verdict agreement: only one layout ran — nothing to compare.");
	}
	lines.push("");
	return `${lines.join("\n")}\n`;
}
