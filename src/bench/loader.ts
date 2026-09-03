/**
 * The source loader.
 *
 * Runs every enabled source inside its own try/catch so one bad source never sinks the run. A
 * source that throws — or that parses but yields zero records (plan finding 10) — produces a
 * `source-failed` event with a reason and the loader moves on. Each source's pinned `version()` is
 * recorded as `sourceVersion` on every record it yields; the cache dir is keyed on that version.
 * Sampling and scoring happen downstream — the loader only produces the flat record set and the
 * per-source event log.
 */

import { cacheDirFor } from "./cache.ts";
import type { BenchRecord, Source, SourceEvent } from "./schema.ts";
import { ALL_SOURCES } from "./sources/index.ts";

export interface LoadOptions {
	/** The sources to consider; defaults to the full registry. */
	sources?: Source[];
	/** Force these source ids on regardless of `enabledByDefault` (used by fetch-smoke/tests). */
	only?: string[];
	signal?: AbortSignal;
}

export interface LoadResult {
	records: BenchRecord[];
	events: SourceEvent[];
}

/** Load all enabled (or `only`-selected) sources, isolating failures as `source-failed` events. */
export async function loadSources(opts: LoadOptions = {}): Promise<LoadResult> {
	const registry = opts.sources ?? ALL_SOURCES;
	const selected = opts.only
		? registry.filter((s) => opts.only?.includes(s.id))
		: registry.filter((s) => s.enabledByDefault);

	const records: BenchRecord[] = [];
	const events: SourceEvent[] = [];

	for (const source of selected) {
		try {
			const version = await source.version();
			const cacheDir = cacheDirFor(source.id, version);
			const raw = await source.fetch(cacheDir, opts.signal);
			const converted = source.convert(raw);
			if (converted.length === 0) {
				events.push({
					type: "source-failed",
					source: source.id,
					reason: "source parsed but yielded zero usable records",
				});
				continue;
			}
			// Ids must be unique: the sample keys on them and `--resume` keys on (id, pass), so a
			// source with colliding ids would judge some records twice and drop others (the design notes —
			// rogue-security once collapsed all 112 rows to `rogue-security/undefined`). A source that
			// cannot produce stable, distinct ids is broken, so fail it whole rather than half-count it.
			const duplicates = countDuplicateIds(converted);
			if (duplicates > 0) {
				events.push({
					type: "source-failed",
					source: source.id,
					reason: `source produced non-unique ids (${duplicates} duplicate of ${converted.length} records) — ids must be unique`,
				});
				continue;
			}
			for (const record of converted) record.sourceVersion = version;
			records.push(...converted);
			events.push({
				type: "source-loaded",
				source: source.id,
				sourceVersion: version,
				count: converted.length,
			});
		} catch (err) {
			events.push({
				type: "source-failed",
				source: source.id,
				reason: err instanceof Error ? err.message : String(err),
			});
		}
	}

	return { records, events };
}

/** Count how many records share an id already seen — 0 means every id is unique. */
function countDuplicateIds(records: BenchRecord[]): number {
	const seen = new Set<string>();
	let duplicates = 0;
	for (const record of records) {
		if (seen.has(record.id)) duplicates++;
		else seen.add(record.id);
	}
	return duplicates;
}
