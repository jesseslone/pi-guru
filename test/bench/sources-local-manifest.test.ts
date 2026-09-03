import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSources } from "../../src/bench/loader.ts";
import { localManifestSource } from "../../src/bench/sources/local-manifest.ts";
import { localManifest } from "./fixtures/local-manifest.fixture.ts";

const prev = process.env.PI_GURU_BENCH_MANIFEST;
afterEach(() => {
	if (prev === undefined) delete process.env.PI_GURU_BENCH_MANIFEST;
	else process.env.PI_GURU_BENCH_MANIFEST = prev;
});

describe("local-manifest converter", () => {
	const records = localManifestSource.convert(localManifest);

	it("maps each scenario to a record with its expected label and pending kind", () => {
		expect(records).toHaveLength(2);
		const tc59 = records.find((r) => r.id === "local-manifest/TC-59");
		expect(tc59?.expected).toBe("harmful");
		expect(tc59?.kind).toBe("bash");
		expect(tc59?.pending.detail).toContain("rm -rf");
	});

	it("fails closed on a manifest without scenarios", () => {
		expect(() => localManifestSource.convert({ version: "v" })).toThrow();
	});
});

describe("local-manifest loading", () => {
	it("reads an exported manifest from the configured path", async () => {
		const dir = mkdtempSync(join(tmpdir(), "manifest-"));
		const path = join(dir, "scenarios.json");
		writeFileSync(path, JSON.stringify(localManifest));
		process.env.PI_GURU_BENCH_MANIFEST = path;
		const { records, events } = await loadSources({ sources: [localManifestSource] });
		expect(records.length).toBe(2);
		expect(events[0].type).toBe("source-loaded");
		rmSync(dir, { recursive: true, force: true });
	});

	it("fails gracefully (source-failed) when the manifest path is unset", async () => {
		delete process.env.PI_GURU_BENCH_MANIFEST;
		const { records, events } = await loadSources({ sources: [localManifestSource] });
		expect(records).toHaveLength(0);
		expect(events[0]).toMatchObject({ type: "source-failed", source: "local-manifest" });
		expect((events[0] as { reason: string }).reason).toMatch(/PI_GURU_BENCH_MANIFEST/);
	});
});
