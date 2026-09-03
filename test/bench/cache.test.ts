import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { benchDir, cacheDirFor, fetchWithCache } from "../../src/bench/cache.ts";

let dir: string;
const prev = process.env.PI_GURU_BENCH_DIR;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-guru-bench-cache-"));
	process.env.PI_GURU_BENCH_DIR = dir;
});
afterEach(() => {
	if (prev === undefined) delete process.env.PI_GURU_BENCH_DIR;
	else process.env.PI_GURU_BENCH_DIR = prev;
	rmSync(dir, { recursive: true, force: true });
});

describe("cache dir", () => {
	it("honours PI_GURU_BENCH_DIR and namespaces by source/version", () => {
		expect(benchDir()).toBe(dir);
		expect(cacheDirFor("redcode-exec", "abc123")).toBe(join(dir, "cache", "redcode-exec", "abc123"));
	});

	it("sanitises a version into one path segment", () => {
		expect(cacheDirFor("s", "a/b:c")).toBe(join(dir, "cache", "s", "a_b_c"));
	});
});

describe("fetchWithCache (TOFU)", () => {
	it("fetches once, writes a sidecar, and serves from cache without re-fetching", async () => {
		const cacheDir = cacheDirFor("s", "v");
		let calls = 0;
		const fetcher = async () => {
			calls++;
			return Buffer.from("payload");
		};
		const a = await fetchWithCache(cacheDir, "d.json", fetcher);
		const b = await fetchWithCache(cacheDir, "d.json", fetcher);
		expect(a.toString()).toBe("payload");
		expect(b.toString()).toBe("payload");
		expect(calls).toBe(1);
		expect(readFileSync(join(cacheDir, "d.json.sha256"), "utf8")).toHaveLength(64);
	});

	it("throws on later corruption of the cached file", async () => {
		const cacheDir = cacheDirFor("s", "v");
		await fetchWithCache(cacheDir, "d.json", async () => Buffer.from("good"));
		writeFileSync(join(cacheDir, "d.json"), "tampered");
		await expect(fetchWithCache(cacheDir, "d.json", async () => Buffer.from("good"))).rejects.toThrow(
			/checksum mismatch/,
		);
	});
});
