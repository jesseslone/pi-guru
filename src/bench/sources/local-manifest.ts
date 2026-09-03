/**
 * local-manifest source.
 *
 * A JSON manifest of your own scenarios, used as transcript templates in this harness. The manifest
 * lives outside this repo and is read from a **configurable external path** (`PI_GURU_BENCH_MANIFEST`).
 * There is no default location: when the env var is unset (or the file is absent) the source fails
 * gracefully — a clear throw the loader turns into a `source-failed` line — and the run continues with
 * the other sources. Nothing from the manifest is copied into this repo.
 *
 * Manifest shape: `{ version, scenarios: [{ id, category, label?, expected, transcript, pending }] }`
 * where `transcript` is `TranscriptTurn[]` and `pending` is a `PendingSpec`.
 */

import { existsSync, readFileSync } from "node:fs";
import { type TranscriptTurn, toEntries } from "../entries.ts";
import { buildPending, type PendingSpec } from "../pending.ts";
import type { BenchRecord, Expected, Source } from "../schema.ts";

const ORIGIN = {
	url: "local: a JSON manifest of your own scenarios (transcript templates)",
	license: "yours — transcript templates, not third-party data",
	attribution: "your own scenarios, exported locally; not redistributed",
};

interface Scenario {
	id: string;
	category: string;
	label?: string;
	expected: Expected;
	transcript: TranscriptTurn[];
	pending: PendingSpec;
}

interface Manifest {
	version: string;
	scenarios: Scenario[];
}

/** The configured manifest path from `PI_GURU_BENCH_MANIFEST`, or undefined when unset. */
export function manifestPath(): string | undefined {
	return process.env.PI_GURU_BENCH_MANIFEST;
}

function readManifest(): Manifest {
	const path = manifestPath();
	if (!path || !existsSync(path)) {
		throw new Error(
			"local-manifest: no manifest found (set PI_GURU_BENCH_MANIFEST to the path of your exported scenarios manifest)",
		);
	}
	const manifest = JSON.parse(readFileSync(path, "utf8")) as Manifest;
	if (!manifest || typeof manifest.version !== "string" || !Array.isArray(manifest.scenarios)) {
		throw new Error("local-manifest: manifest missing version/scenarios — schema drift");
	}
	return manifest;
}

export const localManifestSource: Source = {
	id: "local-manifest",
	license: "yours",
	enabledByDefault: true,

	async version() {
		return `local-manifest/${readManifest().version}`;
	},

	async fetch() {
		return readManifest();
	},

	convert(raw) {
		const manifest = raw as Manifest;
		if (!manifest || !Array.isArray(manifest.scenarios)) {
			throw new Error("local-manifest: expected a manifest with scenarios");
		}
		return manifest.scenarios.map((scenario) => {
			if (!scenario.id || !scenario.pending || !scenario.expected) {
				throw new Error("local-manifest: scenario missing id/pending/expected — schema drift");
			}
			const record: BenchRecord = {
				source: "local-manifest",
				sourceVersion: "",
				id: `local-manifest/${scenario.id}`,
				category: scenario.category || "Safety & Boundaries",
				kind: scenario.pending.kind,
				expected: scenario.expected,
				label: scenario.label ?? scenario.expected,
				transcriptEntries: toEntries(scenario.transcript ?? []),
				pending: buildPending(scenario.pending),
				origin: ORIGIN,
			};
			return record;
		});
	},
};
