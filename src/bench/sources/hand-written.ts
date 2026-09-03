/**
 * Our hand-written cases source.
 *
 * These are the contamination control (plan Risks) and the only source carrying an authored
 * three-way `authoredRisk` label, so the 3×3 confusion view exists for them (plan finding 4). They
 * cover the gaps the survey found: benign-but-scary bash (`rm -rf ./node_modules`, `git reset
 * --hard` on a scratch branch, `chmod +x`, `find ./build -delete`, curl to localhost), genuinely
 * harmful bash, and write/edit cases. Each case file is an array of cases; each case has a one-line
 * `why` retained in the file as the authoring rationale.
 *
 * `PI_GURU_BENCH_CASES_DIR` overrides the directory (used by tests); the default is `bench/cases/`
 * at the repo root, resolved relative to this module.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type TranscriptTurn, toEntries } from "../entries.ts";
import { buildPending, type PendingSpec } from "../pending.ts";
import type { AuthoredRisk, BenchRecord, Expected, Source } from "../schema.ts";

const ORIGIN = {
	url: "https://github.com/jesseslone/pi-guru (bench/cases)",
	license: "MIT",
	attribution: "pi-guru hand-written cases (ours)",
};

/** One hand-authored case, as stored in a `bench/cases/*.json` file. */
interface HandCase {
	id: string;
	category: string;
	expected: Expected;
	authoredRisk: AuthoredRisk;
	/** One-line rationale for the authored label — kept for humans, not carried on the record. */
	why: string;
	transcript?: TranscriptTurn[];
	pending: PendingSpec;
}

/** The cases directory: `PI_GURU_BENCH_CASES_DIR`, else `bench/cases/` at the repo root. */
export function casesDir(): string {
	if (process.env.PI_GURU_BENCH_CASES_DIR) return process.env.PI_GURU_BENCH_CASES_DIR;
	// src/bench/sources/ → repo root is three levels up.
	return fileURLToPath(new URL("../../../bench/cases", import.meta.url));
}

/** Read and concatenate every `*.json` case file in the cases directory, sorted by name. */
function readCases(): { cases: HandCase[]; version: string } {
	const dir = casesDir();
	const files = readdirSync(dir)
		.filter((f) => f.endsWith(".json"))
		.sort();
	const hash = createHash("sha256");
	const cases: HandCase[] = [];
	for (const name of files) {
		const text = readFileSync(join(dir, name), "utf8");
		hash.update(name).update(text);
		const parsed = JSON.parse(text);
		if (!Array.isArray(parsed)) throw new Error(`hand-written: ${name} is not an array of cases`);
		cases.push(...parsed);
	}
	return { cases, version: `hand-written/${hash.digest("hex").slice(0, 12)}` };
}

export const handWrittenSource: Source = {
	id: "hand-written",
	license: "MIT",
	enabledByDefault: true,

	async version() {
		return readCases().version;
	},

	async fetch() {
		return readCases().cases;
	},

	convert(raw) {
		if (!Array.isArray(raw)) throw new Error("hand-written: expected an array of cases");
		return (raw as HandCase[]).map((c) => {
			if (!c.id || !c.pending || !c.expected || !c.authoredRisk) {
				throw new Error(`hand-written: case missing id/pending/expected/authoredRisk (${c.id ?? "?"})`);
			}
			const record: BenchRecord = {
				source: "hand-written",
				sourceVersion: "",
				id: `hand-written/${c.id}`,
				category: c.category || "hand-written",
				kind: c.pending.kind,
				expected: c.expected,
				authoredRisk: c.authoredRisk,
				label: c.authoredRisk,
				transcriptEntries: toEntries(c.transcript ?? []),
				pending: buildPending(c.pending),
				origin: ORIGIN,
			};
			return record;
		});
	},
};
