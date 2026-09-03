import { describe, expect, it } from "vitest";
import {
	ALL_LEVELS,
	DEFAULT_LEVEL,
	deeper,
	EXPLAIN_PROMPTS,
	isExplanationLevel,
	NARRATION_PROMPTS,
	SPOKEN_LEVELS,
} from "../src/levels.ts";

describe("levels — data", () => {
	it("defaults to intermediate", () => {
		expect(DEFAULT_LEVEL).toBe("intermediate");
	});

	it("has an Explain and a narration prompt for every spoken level", () => {
		for (const level of SPOKEN_LEVELS) {
			expect(EXPLAIN_PROMPTS[level].length).toBeGreaterThan(0);
			expect(NARRATION_PROMPTS[level].length).toBeGreaterThan(0);
		}
	});

	it("selects a distinct prompt per level", () => {
		const prompts = SPOKEN_LEVELS.map((l) => EXPLAIN_PROMPTS[l]);
		expect(new Set(prompts).size).toBe(SPOKEN_LEVELS.length);
	});

	it("names commands and flags only at intermediate", () => {
		expect(EXPLAIN_PROMPTS.intermediate).toMatch(/flag/i);
		expect(EXPLAIN_PROMPTS.fundamental).not.toMatch(/flag/i);
	});
});

describe("isExplanationLevel", () => {
	it("accepts the four levels and rejects anything else", () => {
		for (const l of ALL_LEVELS) expect(isExplanationLevel(l)).toBe(true);
		expect(isExplanationLevel("loud")).toBe(false);
		expect(isExplanationLevel(3)).toBe(false);
		expect(isExplanationLevel(undefined)).toBe(false);
	});
});

describe("deeper — re-explain stepping", () => {
	it("steps fundamental → intermediate → technical, and technical repeats", () => {
		expect(deeper("fundamental")).toBe("intermediate");
		expect(deeper("intermediate")).toBe("technical");
		expect(deeper("technical")).toBe("technical");
	});
});
