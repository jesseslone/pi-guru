/**
 * A per-run lock so one run is never written by two processes at once.
 *
 * the design notes closed the in-process double-judging (the runner's dynamic done/in-flight guard) but
 * left a cross-process residual: two separate OS processes resuming the same run inside the same
 * in-flight window can each judge a key once — a TOCTOU the runner alone cannot close. On 2026-09-03
 * two processes judged the same run concurrently. The durable fix is to not dispatch one run twice.
 *
 * `<run>.lock` sits beside the JSONL (same `resultsDir()`), carrying the writer's pid and start time.
 * Acquire writes it; on a lock already held by a **live** pid it refuses; a **dead** pid (or an
 * unreadable file) is stale and taken over. Release removes it, but only while it is still ours.
 *
 * The liveness probe, pid, and clock are injectable so tests use fake pids and a deterministic probe
 * and never call the real `process.kill`.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resultsDir } from "./results.ts";

/** What a `<run>.lock` file records: the writing process and when it started. */
export interface LockInfo {
	pid: number;
	startedAt: string;
}

/** Raised when a run is already locked by a process that is still alive. */
export class RunLockError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RunLockError";
	}
}

/** Injectable seams so tests drive fake pids and a deterministic liveness probe. */
export interface AcquireOptions {
	/** Is `pid` a live process? Defaults to `process.kill(pid, 0)` (ESRCH dead, EPERM alive). */
	isAlive?: (pid: number) => boolean;
	/** The pid to claim the lock for; defaults to this process. */
	pid?: number;
	/** The clock, for the recorded start time; defaults to `Date`. */
	now?: () => Date;
}

/** The lock file path for a run: `<resultsDir>/<run>.lock`, beside its JSONL. */
export function lockPath(runId: string): string {
	return join(resultsDir(), `${runId}.lock`);
}

/** Default liveness probe: signal 0 tests existence. ESRCH → dead; EPERM → alive but not ours. */
function defaultIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Read a lock file, tolerating a missing/corrupt/truncated one (returns null → treat as stale). */
function readLock(path: string): LockInfo | null {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as LockInfo;
		if (typeof parsed.pid === "number" && typeof parsed.startedAt === "string") return parsed;
	} catch {
		// unreadable, empty, or partial — treat as no valid lock (stale, takeable).
	}
	return null;
}

/**
 * A held per-run lock. Construct with `RunLock.acquire`; call `release()` on exit (normal or abort).
 * Acquiring refuses only when an existing lock names a *different, live* process; a dead pid, our own
 * pid, or an unreadable lock file is stale and taken over.
 */
export class RunLock {
	private released = false;

	private constructor(
		readonly runId: string,
		readonly info: LockInfo,
	) {}

	/** Take the lock for `runId`, or throw `RunLockError` if a live process already holds it. */
	static acquire(runId: string, opts: AcquireOptions = {}): RunLock {
		const isAlive = opts.isAlive ?? defaultIsAlive;
		const pid = opts.pid ?? process.pid;
		const now = opts.now ?? (() => new Date());
		const path = lockPath(runId);
		mkdirSync(resultsDir(), { recursive: true });

		if (existsSync(path)) {
			const held = readLock(path);
			if (held && held.pid !== pid && isAlive(held.pid)) {
				throw new RunLockError(
					`run ${runId} is already being written by a live process (pid ${held.pid}, started ${held.startedAt}); ` +
						`refusing to start a second writer. If that process is gone, delete ${path} and retry.`,
				);
			}
			// A dead pid, our own pid, or an unreadable lock is stale — fall through and take it over.
		}

		const info: LockInfo = { pid, startedAt: now().toISOString() };
		writeFileSync(path, `${JSON.stringify(info)}\n`);
		return new RunLock(runId, info);
	}

	/** Remove the lock — but only while it is still ours, so a stale-takeover writer is never freed. */
	release(): void {
		if (this.released) return;
		this.released = true;
		const path = lockPath(this.runId);
		try {
			if (!existsSync(path)) return;
			const held = readLock(path);
			if (!held || held.pid === this.info.pid) rmSync(path, { force: true });
		} catch {
			// best-effort: a lock we cannot remove is at worst stale and will be taken over next run.
		}
	}
}
