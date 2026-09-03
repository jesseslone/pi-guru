import { mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionAllows } from "../src/allows.ts";
import { extractCommandWords } from "../src/classify.ts";

describe("SessionAllows — bash command words", () => {
	it("passes a later call with the same command word", () => {
		const a = new SessionAllows();
		a.allowBash(extractCommandWords("echo hi > x"));
		expect(a.matchesBash(extractCommandWords("echo bye > y"))).toBe(true);
	});

	it("does not pass a different command word", () => {
		const a = new SessionAllows();
		a.allowBash(extractCommandWords("echo hi"));
		expect(a.matchesBash(extractCommandWords("rm x"))).toBe(false);
	});

	it("requires every command word in a chain to be allowed", () => {
		const a = new SessionAllows();
		a.allowBash(extractCommandWords("git status"));
		// git is allowed but npm is not
		expect(a.matchesBash(extractCommandWords("git pull && npm ci"))).toBe(false);
		a.allowBash(extractCommandWords("npm run build"));
		expect(a.matchesBash(extractCommandWords("git pull && npm ci"))).toBe(true);
	});

	it("never matches an unresolved (unparseable) call", () => {
		const a = new SessionAllows();
		a.allowBash(extractCommandWords("echo hi"));
		const unresolved = { resolved: false, words: ["echo"] };
		expect(a.matchesBash(unresolved)).toBe(false);
	});

	it("never matches a call with no command words", () => {
		const a = new SessionAllows();
		expect(a.matchesBash(extractCommandWords("FOO=1"))).toBe(false);
	});

	// C2: a compound approval must not smear its individual words into the set.
	it("does not remember any word from a multi-command approval", () => {
		const a = new SessionAllows();
		a.allowBash(extractCommandWords("git status && rm -rf build"));
		expect(a.list().commands).toEqual([]);
		expect(a.matchesBash(extractCommandWords("rm -rf /important"))).toBe(false);
		expect(a.matchesBash(extractCommandWords("git status"))).toBe(false);
	});

	it("remembers a single-command approval even across an && of the same command", () => {
		const a = new SessionAllows();
		a.allowBash(extractCommandWords("git status && git push")); // one distinct word: git
		expect(a.list().commands).toEqual(["git"]);
		expect(a.matchesBash(extractCommandWords("git commit"))).toBe(true);
	});

	it("does not remember an unresolved approval", () => {
		const a = new SessionAllows();
		a.allowBash(extractCommandWords("timeout 5 rm -rf x")); // unresolved wrapper
		expect(a.isEmpty()).toBe(true);
	});
});

describe("SessionAllows — write/edit directories", () => {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "pi-guru-allows-")));

	it("passes a later write in the same directory", () => {
		const a = new SessionAllows();
		a.allowPathDir("notes/a.txt", cwd);
		expect(a.matchesPath("notes/b.txt", cwd)).toBe(true);
	});

	it("does not pass a write in a different directory", () => {
		const a = new SessionAllows();
		a.allowPathDir("notes/a.txt", cwd);
		expect(a.matchesPath("other/b.txt", cwd)).toBe(false);
	});

	it("follows symlinks so an aliased directory matches its target", () => {
		const target = realpathSync(mkdtempSync(join(tmpdir(), "pi-guru-target-")));
		const link = join(cwd, "linkdir");
		symlinkSync(target, link);
		const a = new SessionAllows();
		a.allowPathDir(join(target, "a.txt"), cwd);
		expect(a.matchesPath(join(link, "b.txt"), cwd)).toBe(true);
	});
});

describe("SessionAllows — list and clear", () => {
	it("lists and clears", () => {
		const a = new SessionAllows();
		a.allowBash(extractCommandWords("git status"));
		a.allowPathDir("/tmp/x.txt", "/tmp");
		expect(a.isEmpty()).toBe(false);
		expect(a.list().commands).toContain("git");
		a.clear();
		expect(a.isEmpty()).toBe(true);
	});
});
