/**
 * the design notes — the per-run lock. Fake pids and an injected `isAlive` probe, so nothing calls the real
 * `process.kill` and no run collides with the test runner's own process.
 *
 * The lock refuses only a *live, foreign* holder; a dead pid, our own pid, or an unreadable lock file
 * is stale and taken over. Release removes the lock only while it is still ours.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type LockInfo, lockPath, RunLock, RunLockError } from "../../src/bench/lock.ts";
import { resultsDir } from "../../src/bench/results.ts";

let dir: string;
const prev = process.env.PI_GURU_BENCH_DIR;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-guru-bench-lock-"));
	process.env.PI_GURU_BENCH_DIR = dir;
});
afterEach(() => {
	if (prev === undefined) delete process.env.PI_GURU_BENCH_DIR;
	else process.env.PI_GURU_BENCH_DIR = prev;
	rmSync(dir, { recursive: true, force: true });
});

/** Write a lock file directly, as a prior process would have. */
function seedLock(runId: string, info: LockInfo): void {
	mkdirSync(resultsDir(), { recursive: true });
	writeFileSync(lockPath(runId), `${JSON.stringify(info)}\n`);
}
function readLockFile(runId: string): LockInfo {
	return JSON.parse(readFileSync(lockPath(runId), "utf8")) as LockInfo;
}

const dead = () => false;
const alive = () => true;

describe("RunLock", () => {
	it("acquire writes {pid, startedAt} beside the JSONL and release removes it", () => {
		const now = () => new Date("2026-09-02T12:00:00.000Z");
		const lock = RunLock.acquire("run-a", { pid: 4242, isAlive: dead, now });
		const path = lockPath("run-a");
		expect(path).toBe(join(resultsDir(), "run-a.lock"));
		expect(existsSync(path)).toBe(true);
		expect(readLockFile("run-a")).toEqual({ pid: 4242, startedAt: "2026-09-02T12:00:00.000Z" });
		expect(lock.info.pid).toBe(4242);

		lock.release();
		expect(existsSync(path)).toBe(false);
	});

	it("refuses when a live foreign process already holds the run, leaving that lock untouched", () => {
		seedLock("run-b", { pid: 111, startedAt: "2026-09-02T00:00:00.000Z" });
		expect(() => RunLock.acquire("run-b", { pid: 222, isAlive: alive })).toThrow(RunLockError);
		try {
			RunLock.acquire("run-b", { pid: 222, isAlive: alive });
		} catch (err) {
			expect((err as Error).message).toContain("pid 111");
			expect((err as Error).message).toContain(lockPath("run-b"));
		}
		// The live holder's lock is left exactly as it was.
		expect(readLockFile("run-b")).toEqual({ pid: 111, startedAt: "2026-09-02T00:00:00.000Z" });
	});

	it("takes over a stale lock whose pid is dead", () => {
		seedLock("run-c", { pid: 111, startedAt: "2026-09-02T00:00:00.000Z" });
		const now = () => new Date("2026-09-02T13:00:00.000Z");
		const lock = RunLock.acquire("run-c", { pid: 999, isAlive: dead, now });
		expect(lock.info.pid).toBe(999);
		expect(readLockFile("run-c")).toEqual({ pid: 999, startedAt: "2026-09-02T13:00:00.000Z" });
	});

	it("takes over a corrupt/empty lock file (unreadable → stale), never probing a pid", () => {
		mkdirSync(resultsDir(), { recursive: true });
		writeFileSync(lockPath("run-d"), "{ not json"); // truncated/garbage
		let probed = false;
		const lock = RunLock.acquire("run-d", {
			pid: 7,
			isAlive: () => {
				probed = true;
				return true;
			},
		});
		expect(probed).toBe(false); // no valid pid to probe
		expect(lock.info.pid).toBe(7);
		expect(readLockFile("run-d").pid).toBe(7);
	});

	it("release only removes a lock that is still ours (a foreign takeover survives)", () => {
		const lock = RunLock.acquire("run-e", { pid: 5, isAlive: dead });
		// Another process takes the run over (as if ours had been declared stale).
		seedLock("run-e", { pid: 6, startedAt: "2026-09-02T14:00:00.000Z" });
		lock.release();
		expect(existsSync(lockPath("run-e"))).toBe(true); // the foreign lock is not deleted
		expect(readLockFile("run-e").pid).toBe(6);
	});

	it("release is idempotent", () => {
		const lock = RunLock.acquire("run-f", { pid: 5, isAlive: dead });
		lock.release();
		lock.release(); // no throw, still gone
		expect(existsSync(lockPath("run-f"))).toBe(false);
	});

	it("re-acquiring in the same process (same pid) takes over without a liveness probe", () => {
		seedLock("run-g", { pid: 42, startedAt: "2026-09-02T00:00:00.000Z" });
		let probed = false;
		const lock = RunLock.acquire("run-g", {
			pid: 42,
			isAlive: () => {
				probed = true;
				return true;
			},
		});
		expect(probed).toBe(false); // same pid → ours → no probe, just take over
		expect(lock.info.pid).toBe(42);
	});

	it("the default probe reports this live process as alive", () => {
		// Seed a lock held by *this* process (definitely alive) and confirm the real probe refuses.
		seedLock("run-h", { pid: process.pid, startedAt: "2026-09-02T00:00:00.000Z" });
		// A different (impossible) pid claim so it is treated as foreign; the held pid is this process.
		expect(() => RunLock.acquire("run-h", { pid: process.pid + 1 })).toThrow(RunLockError);
	});
});
