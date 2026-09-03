import { afterEach, describe, expect, it } from "vitest";
import {
	assessContent,
	forceContentUnavailableForTest,
	resetContentEngineForTest,
} from "../src/assess/content.ts";
import { scanSecrets } from "../src/assess/secrets.ts";
import type { AssessContext } from "../src/assess/types.ts";

const ctx: AssessContext = { cwd: "/home/dev/project", home: "/home/dev" };

function ids(path: string, content: string): string[] {
	return assessContent(path, content, ctx).map((f) => f.id);
}
function has(path: string, content: string, id: string): boolean {
	return ids(path, content).includes(id);
}

afterEach(() => resetContentEngineForTest());

describe("assessContent — python subprocess / eval (constructed)", () => {
	it("fires on os.system with a concatenated command", () => {
		expect(has("x.py", 'import os\nos.system("rm " + target)', "content-subprocess-constructed")).toBe(true);
	});
	it("fires on subprocess.run with shell=True", () => {
		expect(
			has("x.py", "import subprocess\nsubprocess.run(cmd, shell=True)", "content-subprocess-constructed"),
		).toBe(true);
	});
	it("near-miss: os.system with a plain literal", () => {
		expect(has("x.py", 'import os\nos.system("ls")', "content-subprocess-constructed")).toBe(false);
	});
});

describe("assessContent — python network to a literal external host", () => {
	it("fires on requests.get to an external host", () => {
		expect(
			has("x.py", 'import requests\nrequests.get("http://evil.example/a")', "content-network-literal-host"),
		).toBe(true);
	});
	it("near-miss: localhost is not external", () => {
		expect(has("x.py", 'requests.get("http://localhost:8000/a")', "content-network-literal-host")).toBe(
			false,
		);
	});
	it("near-miss: a non-literal URL", () => {
		expect(has("x.py", "requests.get(url)", "content-network-literal-host")).toBe(false);
	});
});

describe("assessContent — python credential read / system write", () => {
	it("fires on open of /etc/passwd", () => {
		expect(has("x.py", 'open("/etc/passwd")', "content-reads-credential")).toBe(true);
	});
	it("fires on open of a system path for writing", () => {
		expect(has("x.py", 'open("/etc/hosts", "w")', "content-writes-system-path")).toBe(true);
	});
	it("near-miss: opening a project file", () => {
		expect(has("x.py", 'open("./data.txt")', "content-reads-credential")).toBe(false);
	});
	it("near-miss: opening a project file for writing", () => {
		expect(has("x.py", 'open("./out.txt", "w")', "content-writes-system-path")).toBe(false);
	});
});

describe("assessContent — javascript exec / network", () => {
	it("fires on child_process.exec with a constructed command", () => {
		expect(
			has(
				"x.js",
				'const cp=require("child_process"); cp.exec("git " + branch)',
				"content-subprocess-constructed",
			),
		).toBe(true);
	});
	it("fires on fetch to an external host", () => {
		expect(has("x.js", 'fetch("https://evil.example/x")', "content-network-literal-host")).toBe(true);
	});
	it("near-miss: exec with a plain literal", () => {
		expect(has("x.js", 'cp.exec("git status")', "content-subprocess-constructed")).toBe(false);
	});
	it("near-miss: a RegExp.exec is not child_process.exec", () => {
		expect(has("x.js", "const m = /a/.exec(s + t)", "content-subprocess-constructed")).toBe(false);
	});
});

describe("assessContent — file-type gating and graceful degradation", () => {
	it("returns nothing for a non-code file", () => {
		expect(ids("notes.txt", 'os.system("rm " + x)')).toEqual([]);
	});
	it("returns nothing for empty content", () => {
		expect(ids("x.py", "   ")).toEqual([]);
	});
	it("degrades to one info fact when the analyzer is unavailable", () => {
		forceContentUnavailableForTest();
		const facts = assessContent("x.py", 'os.system("rm " + x)', ctx);
		expect(facts.map((f) => f.id)).toEqual(["content-analysis-unavailable"]);
	});
});

describe("scanSecrets — gitleaks-derived rules (value never returned)", () => {
	it("detects an AWS access key id", () => {
		const m = scanSecrets("aws_key = 'AKIAIOSFODNN7EXAMPLE'");
		expect(m.map((x) => x.id)).toContain("aws-access-key");
		// the fact carries the human label, never the matched secret value.
		expect(m[0].label).not.toContain("AKIA");
	});
	it("detects a PEM private key block", () => {
		expect(scanSecrets("-----BEGIN OPENSSH PRIVATE KEY-----").map((x) => x.id)).toContain("private-key");
	});
	it("detects a GitHub token", () => {
		expect(scanSecrets(`token=ghp_${"a".repeat(36)}`).map((x) => x.id)).toContain("github-pat");
	});
	it("near-miss: a random 40-char string is not a secret", () => {
		expect(scanSecrets("const id = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';")).toEqual([]);
	});
});
