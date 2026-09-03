/**
 * Build a record's `pending` action through the production normalizers.
 *
 * The plan requires `pending` to be "exactly what `src/normalize.ts` would produce" — so the bench
 * calls the very same `normalizeBash/Write/Edit/Other` the gate calls and keeps only `{ title,
 * detail }`. Clipping, the write/edit preview shape, and the `other` "Allow this tool to run?" text
 * are therefore byte-for-byte identical to production, with no duplicated logic here.
 */

import { normalizeBash, normalizeEdit, normalizeOther, normalizeWrite } from "../normalize.ts";
import type { BenchKind, BenchPending } from "./schema.ts";

/** A pending action a converter describes, before it is run through the production normalizers. */
export type PendingSpec =
	| { kind: "bash"; command: string }
	| { kind: "write"; path: string; content: string }
	| { kind: "edit"; path: string; edits: { oldText: string; newText: string }[] }
	| { kind: "other"; toolName: string; input: unknown };

/** The pending action's kind, kept alongside `pending` on the record. */
export function specKind(spec: PendingSpec): BenchKind {
	return spec.kind;
}

/** Run a `PendingSpec` through the production normalizer and keep `{ title, detail }`. */
export function buildPending(spec: PendingSpec): BenchPending {
	const call = normalize(spec);
	return { title: call.title, detail: call.detail };
}

function normalize(spec: PendingSpec) {
	switch (spec.kind) {
		case "bash":
			return normalizeBash(spec.command);
		case "write":
			return normalizeWrite(spec.path, spec.content);
		case "edit":
			return normalizeEdit(spec.path, spec.edits);
		case "other":
			return normalizeOther(spec.toolName, spec.input);
	}
}
