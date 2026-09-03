/**
 * bench:fetch-smoke — the one script that fetches sources for real.
 *
 * Unit tests never hit the network; this does, once, into a throwaway /tmp cache (never the real
 * `~/.pi`) so a person can confirm the pins, the datasets-server/GitHub endpoints, and the
 * converters against live data. It runs the enabled sources through the real loader and prints a
 * summary — per-source counts, `source-failed` reasons, and a small sample (ids/kinds/expected
 * only; no rogue-security details are printed, since that data is NC). The report is also written
 * to the temp dir so the result survives a broken pipe.
 *
 * Usage: `npm run bench:fetch-smoke`
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSources } from "../src/bench/loader.ts";
import { sample } from "../src/bench/sample.ts";

async function main() {
	const dir = mkdtempSync(join(tmpdir(), "pi-guru-bench-fetch-"));
	process.env.PI_GURU_BENCH_DIR = dir;
	console.log(`[fetch-smoke] cache dir: ${dir}\n`);

	const reportPath = join(dir, "fetch-smoke-report.json");
	const started = new Date().toISOString();

	const { records, events } = await loadSources();

	// Checkpoint the raw result to disk before formatting anything for the console.
	writeFileSync(
		reportPath,
		JSON.stringify(
			{
				started,
				finished: new Date().toISOString(),
				events,
				counts: countBy(records.map((r) => r.source)),
			},
			null,
			2,
		),
	);

	console.log("[fetch-smoke] source events:");
	for (const e of events) {
		if (e.type === "source-loaded") {
			console.log(`  ✓ ${e.source} @ ${e.sourceVersion} — ${e.count} records`);
		} else {
			console.log(`  ✗ ${e.source} — ${e.reason}`);
		}
	}

	console.log(`\n[fetch-smoke] total records: ${records.length}`);
	const shown = sample(records, { seed: "fetch-smoke", limit: 8 });
	console.log("[fetch-smoke] sample (id / kind / expected):");
	for (const r of shown) console.log(`  ${r.id}  [${r.kind}]  ${r.expected}`);

	console.log(`\n[fetch-smoke] report written to ${reportPath}`);
}

function countBy(ids: string[]): Record<string, number> {
	const out: Record<string, number> = {};
	for (const id of ids) out[id] = (out[id] ?? 0) + 1;
	return out;
}

main().catch((err) => {
	console.error("[fetch-smoke] failed:", err);
	process.exit(1);
});
