/**
 * control_arena_agentdojo source — OFF BY DEFAULT pending licence confirmation.
 *
 * HF `adityaasinha28/control_arena_agentdojo` has no license and no card (plan finding 13, Risks),
 * so its converter ships but `enabledByDefault: false` until terms are confirmed. These are AgentDojo
 * banking trajectories (`send_money`, `read_file`, …), not shell — an adapted source. Each row's
 * `transcript` is a text blob of `[USER] / [ASSISTANT] / [TOOL CALLS] name({...}) / [TOOL]` segments;
 * the last tool call is the pending action (foreign → `kind: "other"` via `normalizeOther`), and the
 * text before it is the transcript. `ground_truth` 1 → harmful, 0 → benign.
 */

import { toEntries } from "../entries.ts";
import { buildPending, type PendingSpec } from "../pending.ts";
import type { BenchRecord, Source } from "../schema.ts";

const DATASET = "adityaasinha28/control_arena_agentdojo";
const REVISION = "a0f1e2131a8f27ebe14c285fa8ad34e439d128e2";
const ORIGIN = {
	url: `https://huggingface.co/datasets/${DATASET}`,
	license: "no license — private evaluation, not redistributed",
	attribution: "control_arena_agentdojo (HF) — adapted banking trajectories; last tool call taken as pending",
};

interface CaRow {
	id: string;
	transcript: string;
	ground_truth: number;
	setting_description?: string;
}

export const controlArenaAgentdojoSource: Source = {
	id: "control-arena-agentdojo",
	license: "no license (unconfirmed)",
	enabledByDefault: false, // licence unconfirmed — see module header

	async version() {
		return REVISION;
	},

	async fetch() {
		throw new Error(
			"control-arena-agentdojo: disabled (licence unconfirmed) — enable and implement fetch to use it",
		);
	},

	convert(raw) {
		if (!Array.isArray(raw)) throw new Error("control-arena-agentdojo: expected an array of rows");
		const records: BenchRecord[] = [];
		for (const row of raw as CaRow[]) {
			if (typeof row.transcript !== "string") {
				throw new Error("control-arena-agentdojo: row missing transcript — schema drift");
			}
			const calls = [...row.transcript.matchAll(/\[TOOL CALLS\]\s*\n\s*(\w+)\((\{[\s\S]*?\})\)/g)];
			if (calls.length === 0) continue; // nothing to judge
			const last = calls[calls.length - 1];
			const pending = toPending(last[1], last[2]);
			const before = row.transcript.slice(0, last.index).trim();
			records.push({
				source: "control-arena-agentdojo",
				sourceVersion: "",
				id: `control-arena-agentdojo/${row.id}`,
				category: row.setting_description || "agentdojo",
				kind: pending.kind,
				expected: row.ground_truth === 1 ? "harmful" : "benign",
				label: String(row.ground_truth),
				transcriptEntries: toEntries(before ? [{ role: "user", text: before }] : []),
				pending: buildPending(pending),
				origin: ORIGIN,
			});
		}
		return records;
	},
};

/** Turn a `name({json})` tool call into a foreign `PendingSpec`. */
function toPending(name: string, argsJson: string): PendingSpec {
	let input: unknown = argsJson;
	try {
		input = JSON.parse(argsJson);
	} catch {
		// keep the raw string as the input if it isn't valid JSON
	}
	return { kind: "other", toolName: name, input };
}
