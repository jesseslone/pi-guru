import { describe, expect, it } from "vitest";
import { parsePyLiteral } from "../../src/bench/pyliteral.ts";

describe("parsePyLiteral", () => {
	it("parses a single-quoted Python dict with True/False/None", () => {
		expect(parsePyLiteral("{'a': 1, 'b': True, 'c': None, 'd': False}")).toEqual({
			a: 1,
			b: true,
			c: null,
			d: false,
		});
	});

	it("parses ordinary double-quoted JSON", () => {
		expect(parsePyLiteral('{"x": [1, 2, 3], "y": "hi"}')).toEqual({ x: [1, 2, 3], y: "hi" });
	});

	it("handles nested tool-call shape and escaped newlines", () => {
		const s =
			"{'role': 'assistant', 'tool_calls': [{'name': 'Shell', 'arguments': {'command': 'echo a\\nb'}}]}";
		const parsed = parsePyLiteral(s) as {
			tool_calls: { name: string; arguments: { command: string } }[];
		};
		expect(parsed.tool_calls[0].name).toBe("Shell");
		expect(parsed.tool_calls[0].arguments.command).toBe("echo a\nb");
	});

	it("throws on malformed input", () => {
		expect(() => parsePyLiteral("{'a': }")).toThrow();
		expect(() => parsePyLiteral("not a literal")).toThrow();
	});
});
