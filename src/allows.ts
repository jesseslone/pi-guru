/**
 * Session allow store: remembered approvals that let later change calls with the same
 * bash command word — or write/edit in the same directory — pass the gate for the rest
 * of the session (CONTEXT.md). In-memory only; nothing is persisted.
 */

import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { CommandWords } from "./classify.ts";

export class SessionAllows {
	/** Allowed bash command words (e.g. `git`, `npm`). */
	private readonly bashWords = new Set<string>();
	/** Allowed write/edit directories, symlink-resolved absolute paths. */
	private readonly dirs = new Set<string>();

	/**
	 * Remember an approved bash call — but only when it resolved to a *single* command word.
	 * A compound the person approved (e.g. `git status && rm -rf build`) resolves to several
	 * words; smearing all of them into the set would grant a later bare `rm`,
	 * so a multi-word approval is remembered as nothing and simply re-gates next time. An
	 * unresolved call (substitution / non-allowlisted wrapper) is never remembered either.
	 */
	allowBash(words: CommandWords): void {
		if (!words.resolved || words.words.length !== 1) return;
		this.bashWords.add(words.words[0]);
	}

	/** Remember the directory of an approved write/edit call. */
	allowPathDir(filePath: string, cwd: string): void {
		this.dirs.add(resolveDir(filePath, cwd));
	}

	/**
	 * A bash call matches when it resolved cleanly, names at least one command word, and
	 * every one of its command words is already allowed (so `git status && git push`
	 * passes once `git` is allowed).
	 */
	matchesBash(words: CommandWords): boolean {
		if (!words.resolved || words.words.length === 0) return false;
		return words.words.every((w) => this.bashWords.has(w));
	}

	/** A write/edit call matches when its resolved directory is exactly an allowed one. */
	matchesPath(filePath: string, cwd: string): boolean {
		return this.dirs.has(resolveDir(filePath, cwd));
	}

	/** Human-readable snapshot for the `/gate` command. */
	list(): { commands: string[]; directories: string[] } {
		return {
			commands: [...this.bashWords].sort(),
			directories: [...this.dirs].sort(),
		};
	}

	isEmpty(): boolean {
		return this.bashWords.size === 0 && this.dirs.size === 0;
	}

	clear(): void {
		this.bashWords.clear();
		this.dirs.clear();
	}
}

/**
 * Resolve a file path to its symlink-followed parent directory. When the file does not
 * yet exist (a fresh write), fall back to realpath of the directory itself, and when
 * that too is missing, to the lexically-resolved directory.
 */
function resolveDir(filePath: string, cwd: string): string {
	const abs = resolve(cwd, filePath);
	try {
		return dirname(realpathSync(abs));
	} catch {
		const dir = dirname(abs);
		try {
			return realpathSync(dir);
		} catch {
			return dir;
		}
	}
}
