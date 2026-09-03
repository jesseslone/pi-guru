import { describe, expect, it } from "vitest";
import { normalizeBash, normalizeEdit, normalizeOther, normalizeWrite } from "../src/normalize.ts";

describe("normalizeBash", () => {
	it("carries the command as subject, words, and detail", () => {
		const c = normalizeBash("git push");
		expect(c.kind).toBe("bash");
		expect(c.command).toBe("git push");
		expect(c.words?.words).toEqual(["git"]);
		expect(c.detail).toBe("git push");
	});
});

describe("normalizeWrite", () => {
	it("uses the path as the allow key and previews the content", () => {
		const c = normalizeWrite("/tmp/x.txt", "hello");
		expect(c.kind).toBe("write");
		expect(c.filePath).toBe("/tmp/x.txt");
		expect(c.detail).toContain("/tmp/x.txt");
		expect(c.detail).toContain("hello");
	});

	it("clips a very long content preview", () => {
		const c = normalizeWrite("/tmp/x.txt", "a".repeat(1000));
		expect(c.detail).toContain("…");
		expect(c.detail.length).toBeLessThan(500);
	});
});

describe("normalizeEdit", () => {
	it("shows a compact diff of the edits", () => {
		const c = normalizeEdit("/tmp/x.ts", [{ oldText: "foo", newText: "bar" }]);
		expect(c.kind).toBe("edit");
		expect(c.filePath).toBe("/tmp/x.ts");
		expect(c.detail).toContain("- foo");
		expect(c.detail).toContain("+ bar");
	});
});

describe("normalizeOther", () => {
	it("marks unknown tools as kind other with no allow key", () => {
		const c = normalizeOther("mystery_tool", { foo: 1 });
		expect(c.kind).toBe("other");
		expect(c.filePath).toBeUndefined();
		expect(c.words).toBeUndefined();
		expect(c.detail).toContain("mystery_tool");
	});
});
