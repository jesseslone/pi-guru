/**
 * The judge benchmark record schema and source contract.
 *
 * Every source converts to the same `BenchRecord`, so the runner never sees a source-specific
 * field. A record reduces to what the production judge consumes: a flattened transcript (as pi
 * `SessionEntry[]`, flattened by `src/transcript.ts`) plus a `pending` action (exactly what
 * `src/normalize.ts` produces), with a binary `expected` label and provenance. The three-way
 * `authoredRisk` exists only on our hand-written cases, where we wrote that label ourselves.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/** The pending action's tool kind. `other` holds foreign/unknown tools (plan finding 3). */
export type BenchKind = "bash" | "write" | "edit" | "other";

/**
 * Ground-truth label. `harmful`/`benign` are the two scored classes (medium is never a truth, plan
 * finding 4). `benign-for-gate` is a third class for source records the source labels
 * risky but whose execution does not endanger the person's machine or data (RedCode's code-weakness
 * scenarios): reported in its own row, never a harmful let-through and never a benign-blocked.
 */
export type Expected = "harmful" | "benign" | "benign-for-gate";

/** The three-way risk label — only hand-written cases carry it (plan finding 4). */
export type AuthoredRisk = "low" | "medium" | "high";

/** Where a record came from, attributed in every report. */
export interface BenchOrigin {
	url: string;
	license: string;
	attribution: string;
}

/** The pending action shown at the gate — exactly `{ title, detail }` from `src/normalize.ts`. */
export interface BenchPending {
	title: string;
	detail: string;
}

/** One benchmark record. `sourceVersion` is stamped by the loader from the pinned `version()`. */
export interface BenchRecord {
	source: string;
	sourceVersion: string;
	/** Stable id — deterministic sampling and `--resume` key on this (plan finding 7). */
	id: string;
	category: string;
	kind: BenchKind;
	expected: Expected;
	/** Only on hand-written cases (plan finding 4). */
	authoredRisk?: AuthoredRisk;
	/** The source's own label, verbatim (e.g. rogue-security `F5`, R-Judge `1`). */
	label: string;
	/** The conversation so far, in pi `SessionEntry` shape (flattened by `src/transcript.ts`). */
	transcriptEntries: SessionEntry[];
	pending: BenchPending;
	origin: BenchOrigin;
}

/**
 * One source, isolated (plan "Sources, isolated"). The loader calls `version()` for the pinned
 * commit/revision, `fetch()` to get raw data into the cache (with a TOFU checksum), then the pure
 * `convert()` to records. `convert` must fail closed (throw) on a schema it no longer understands
 * rather than yielding garbage. `enabledByDefault` is false for sources whose licence is unconfirmed.
 */
export interface Source {
	id: string;
	license: string;
	enabledByDefault: boolean;
	/** The pinned commit hash or dataset revision, recorded as `sourceVersion`. */
	version(): Promise<string>;
	/** Fetch raw data into `cacheDir` (TOFU checksum) and return it parsed. */
	fetch(cacheDir: string, signal?: AbortSignal): Promise<unknown>;
	/** Convert raw data to records (pure). Throws on a schema mismatch; may yield zero. */
	convert(raw: unknown): BenchRecord[];
	/**
	 * Recompute a record's `expected` label purely from its id, when the source's labelling is a
	 * function of the id. Returns `undefined` for sources whose expected is
	 * per-record and not id-derivable, so `rescore` keeps their stored label.
	 */
	expectedForId?(id: string): Expected | undefined;
}

/** What the loader records per source: a success line or a `source-failed` line (plan finding 10). */
export type SourceEvent =
	| { type: "source-loaded"; source: string; sourceVersion: string; count: number }
	| { type: "source-failed"; source: string; reason: string };
