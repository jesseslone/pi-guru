/**
 * The fact → floor mapping. Only the enumerated facts impose a deterministic
 * floor; content and secret facts are context for the judge, never a floor (precision-first — file
 * content is weaker evidence than a resolved path or a parsed command).
 *
 * High floor: reading credentials/keys, piping the network into a shell, sending local data to a
 * remote. Medium floor: writing under a system path, eval/dynamic execution, sudo, and a recursive
 * delete resolved outside the project.
 */

import type { Fact, Floor } from "./types.ts";

/** Fact ids that floor risk to high. */
export const HIGH_FLOOR_FACTS = new Set([
	"reads-credential-file",
	"network-to-shell",
	"network-send-local-data",
]);

/** Fact ids that floor risk to medium. */
export const MEDIUM_FLOOR_FACTS = new Set([
	"writes-system-path",
	"eval-dynamic-exec",
	"sudo",
	"recursive-delete-outside-cwd",
]);

const FLOOR_ORDER: Record<Floor, number> = { medium: 1, high: 2 };

/** The floor one fact imposes, or undefined when it imposes none. */
export function factFloor(fact: Fact): Floor | undefined {
	if (HIGH_FLOOR_FACTS.has(fact.id)) return "high";
	if (MEDIUM_FLOOR_FACTS.has(fact.id)) return "medium";
	return undefined;
}

/**
 * The strongest floor across a fact list and the fact that determined it — the highest floor, and
 * within that floor the first fact in list order. Returns undefined when nothing floors.
 */
export function strongestFloor(facts: Fact[]): { floor: Floor; fact: Fact } | undefined {
	let best: { floor: Floor; fact: Fact } | undefined;
	for (const fact of facts) {
		const floor = factFloor(fact);
		if (!floor) continue;
		if (!best || FLOOR_ORDER[floor] > FLOOR_ORDER[best.floor]) best = { floor, fact };
	}
	return best;
}
