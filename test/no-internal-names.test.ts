import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guards the public build: the maintainer's private-infrastructure names must never re-enter the
 * code or tests. This mirrors the release grep
 *   grep -rniE "<forbidden>" src extensions test bench
 * so it stays enforced in CI. The forbidden terms are assembled from fragments below so this file
 * does not itself contain the strings it forbids.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIRS = ["src", "extensions", "test", "bench"];

const FORBIDDEN = [
	["be", "astmode"],
	["sp", "ark"],
	["sand", "castle"],
	["noi", "sy-agents"],
	["apf", "-recovery"],
	["pi", "-delegate"],
].map((parts) => parts.join(""));

const PATTERN = new RegExp(FORBIDDEN.join("|"), "i");

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules") continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walk(full));
		else if (entry.isFile()) out.push(full);
	}
	return out;
}

describe("no internal-infrastructure names", () => {
	it("the tree carries none of the forbidden names", () => {
		const offenders: string[] = [];
		for (const dir of DIRS) {
			for (const file of walk(join(ROOT, dir))) {
				const text = readFileSync(file, "utf8");
				const lines = text.split("\n");
				lines.forEach((line, i) => {
					if (PATTERN.test(line)) offenders.push(`${relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
				});
			}
		}
		expect(offenders).toEqual([]);
	});
});
