/**
 * Deterministic per-source sampling.
 *
 * Two models compared with the same `seed` and `limit` must see the same records, and `--resume`
 * must key on a stable set — so selection is a pure function of `(seed, record id)`, never of input
 * order or `Math.random`. Records are ranked by `sha256(seed + ":" + id)` and the first `limit`
 * per source taken; because ids are stable, the sample is stable regardless of how the source yielded them.
 */

import { createHash } from "node:crypto";
import type { BenchRecord } from "./schema.ts";

export interface SampleOptions {
	seed: string | number;
	/** Max records to keep; `undefined` or a non-positive value keeps them all (still ordered). */
	limit?: number;
}

/**
 * Deterministically sample records by `(seed, id)`, with `limit` applied PER SOURCE so every
 * source keeps up to `limit` records and a large source cannot crowd the others out of the
 * sample (the report is per source, so the sample must be too). Stable across input order.
 */
export function sample(records: BenchRecord[], opts: SampleOptions): BenchRecord[] {
	const seed = String(opts.seed);
	const ranked = records
		.map((record) => ({ record, key: rankKey(seed, record.id) }))
		.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
		.map((r) => r.record);
	if (opts.limit === undefined || opts.limit <= 0) return ranked;
	const taken = new Map<string, number>();
	return ranked.filter((record) => {
		const n = taken.get(record.source) ?? 0;
		if (n >= (opts.limit as number)) return false;
		taken.set(record.source, n + 1);
		return true;
	});
}

/** A stable sort key for one record under one seed. */
function rankKey(seed: string, id: string): string {
	return createHash("sha256").update(`${seed}:${id}`).digest("hex");
}
