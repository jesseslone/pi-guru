/**
 * R-Judge source — OFF BY DEFAULT pending licence confirmation.
 *
 * `github.com/Lordog/R-Judge` ships no LICENSE file (plan finding 13, Risks). Its converter is
 * built and tested here, but `enabledByDefault: false`: the source is fetched only for private
 * evaluation and never enabled — and never redistributed — until its terms are confirmed with the
 * authors. Flip `enabledByDefault` to `true` only after that.
 *
 * A record's `contents` is a list of sessions, each a list of `user` / `agent {thought, action}` /
 * `environment` turns. The last agent action is the pending call; the turns before it are the
 * transcript. The trajectory label attaches to the final action (true in the terminal cases the
 * survey inspected). Bash actions map to `normalizeBash`; every other pseudo-API action is `kind:
 * "other"` through `normalizeOther`, so `pending.detail` matches production and the source is
 * labelled "adapted" in the report.
 */

import { type TranscriptTurn, toEntries } from "../entries.ts";
import { buildPending, type PendingSpec } from "../pending.ts";
import type { BenchRecord, Source } from "../schema.ts";

const REPO = "Lordog/R-Judge";
const COMMIT = "83ce301da3ad50dd8b397e772863f5411c3d3dc2";
const ORIGIN = {
	url: `https://github.com/${REPO}`,
	license: "no license — private evaluation, not redistributed",
	attribution: "R-Judge (Lordog/R-Judge) — adapted; last agent action taken as the pending call",
};

interface RTurn {
	role: string;
	content?: string | null;
	thought?: string | null;
	action?: string | null;
}

interface RRecord {
	id: number;
	scenario: string;
	profile?: string;
	goal?: string;
	contents: RTurn[][];
	label: number;
	risk_description?: string;
	attack_type?: string;
}

export const rJudgeSource: Source = {
	id: "r-judge",
	license: "no license (unconfirmed)",
	enabledByDefault: false, // licence unconfirmed — see module header

	async version() {
		return COMMIT;
	},

	async fetch() {
		// Left unimplemented on the default path: the source is disabled, so the loader never
		// fetches it. A private evaluation would fetch `data/**` at the pinned commit here.
		throw new Error("r-judge: disabled (licence unconfirmed) — enable and implement fetch to use it");
	},

	convert(raw) {
		if (!Array.isArray(raw)) throw new Error("r-judge: expected an array of records");
		const records: BenchRecord[] = [];
		(raw as RRecord[]).forEach((rec, idx) => {
			if (!Array.isArray(rec.contents)) throw new Error("r-judge: record missing contents — schema drift");
			const turns = rec.contents.flat();
			const lastAgent = lastIndex(turns, (t) => t.role === "agent" && !!t.action);
			if (lastAgent === -1) return; // no agent action to judge
			const pending = actionToPending(turns[lastAgent].action ?? "");
			records.push({
				source: "r-judge",
				sourceVersion: "",
				id: `r-judge/${rec.scenario}/${idx}`,
				category: rec.attack_type || rec.scenario || "r-judge",
				kind: pending.kind,
				expected: rec.label === 1 ? "harmful" : "benign",
				label: String(rec.label),
				transcriptEntries: toEntries(
					turns.slice(0, lastAgent).map(turnToTranscript).filter(Boolean) as TranscriptTurn[],
				),
				pending: buildPending(pending),
				origin: ORIGIN,
			});
		});
		return records;
	},
};

/** Map an R-Judge action string to a `PendingSpec`: bash if fenced/terminal, else a foreign tool. */
function actionToPending(action: string): PendingSpec {
	const fenced = /```(?:bash|sh)?\s*\n([\s\S]*?)```/.exec(action);
	const name = action.split("\n", 1)[0].trim();
	if (fenced) return { kind: "bash", command: fenced[1].trim() };
	if (/^(bash|terminal|shell)\b/i.test(name)) {
		return { kind: "bash", command: action.replace(/^\S+\s*/, "").trim() };
	}
	const input = /Action Input:\s*([\s\S]*)$/.exec(action)?.[1]?.trim() ?? "";
	return { kind: "other", toolName: name || "action", input };
}

/** Map a transcript turn to a terse `TranscriptTurn`, or null to drop it (empty environment). */
function turnToTranscript(turn: RTurn): TranscriptTurn | null {
	if (turn.role === "user" && turn.content) return { role: "user", text: turn.content };
	if (turn.role === "environment" && turn.content) {
		return { role: "user", text: `[tool result] ${turn.content}` };
	}
	if (turn.role === "agent") {
		const text = [turn.thought ?? "", turn.action ?? ""].filter(Boolean).join("\n");
		if (text) return { role: "assistant", text };
	}
	return null;
}

function lastIndex<T>(arr: T[], pred: (t: T) => boolean): number {
	for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) return i;
	return -1;
}
