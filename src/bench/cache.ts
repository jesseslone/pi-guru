/**
 * The bench cache directory and trust-on-first-use checksums.
 *
 * Fetched source data is cached under pi's agent dir at `pi-guru-bench/cache/<source>/<version>/`,
 * overridable in whole by `PI_GURU_BENCH_DIR` — every test and the fetch-smoke set that env var to
 * a temp dir so the real `~/.pi` is never touched. Nothing is written under the repo.
 *
 * Checksums are trust-on-first-use: the pinned commit/revision is the integrity anchor, so the
 * first fetch simply writes `<file>` and a `<file>.sha256` sidecar; every later load re-hashes the
 * cached bytes and fails loudly on a mismatch, catching only later corruption of the local cache.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** The root of all bench local state: `PI_GURU_BENCH_DIR`, else `<agentDir>/pi-guru-bench`. */
export function benchDir(): string {
	return process.env.PI_GURU_BENCH_DIR ?? join(getAgentDir(), "pi-guru-bench");
}

/** The cache directory for one source at one pinned version. */
export function cacheDirFor(sourceId: string, version: string): string {
	return join(benchDir(), "cache", sourceId, safeSegment(version));
}

/**
 * Read `filename` from `cacheDir`, verifying its TOFU sidecar; on a cache miss, call `fetcher`,
 * write the bytes and a fresh `<file>.sha256`, and return them. Throws on a checksum mismatch.
 */
export async function fetchWithCache(
	cacheDir: string,
	filename: string,
	fetcher: () => Promise<Buffer>,
): Promise<Buffer> {
	mkdirSync(cacheDir, { recursive: true });
	const file = join(cacheDir, filename);
	const sidecar = `${file}.sha256`;

	if (existsSync(file) && existsSync(sidecar)) {
		const bytes = readFileSync(file);
		const want = readFileSync(sidecar, "utf8").trim();
		const got = sha256(bytes);
		if (got !== want) {
			throw new Error(`cache checksum mismatch for ${filename}: expected ${want}, got ${got}`);
		}
		return bytes;
	}

	const bytes = await fetcher();
	writeFileSync(file, bytes);
	writeFileSync(sidecar, sha256(bytes));
	return bytes;
}

/** Hex SHA-256 of some bytes. */
export function sha256(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** Keep a version string usable as one path segment (commit hashes and revisions are already safe). */
function safeSegment(version: string): string {
	return version.replace(/[^A-Za-z0-9._-]/g, "_") || "unversioned";
}
