import { describe, expect, it } from "vitest";
import { buildPending, specKind } from "../../src/bench/pending.ts";
import { normalizeBash, normalizeEdit, normalizeOther, normalizeWrite } from "../../src/normalize.ts";

describe("buildPending", () => {
	it("bash matches normalizeBash byte-for-byte", () => {
		const call = normalizeBash("rm -rf ./node_modules");
		expect(buildPending({ kind: "bash", command: "rm -rf ./node_modules" })).toEqual({
			title: call.title,
			detail: call.detail,
		});
	});

	it("write matches normalizeWrite (including the clip/preview)", () => {
		const content = "x".repeat(1000);
		const call = normalizeWrite("/repo/.env", content);
		expect(buildPending({ kind: "write", path: "/repo/.env", content })).toEqual({
			title: call.title,
			detail: call.detail,
		});
	});

	it("edit matches normalizeEdit", () => {
		const edits = [{ oldText: "a", newText: "b" }];
		const call = normalizeEdit("/repo/f.ts", edits);
		expect(buildPending({ kind: "edit", path: "/repo/f.ts", edits })).toEqual({
			title: call.title,
			detail: call.detail,
		});
	});

	it("other matches normalizeOther for a foreign tool", () => {
		const input = { recipient: "x", amount: 9999 };
		const call = normalizeOther("send_money", input);
		expect(buildPending({ kind: "other", toolName: "send_money", input })).toEqual({
			title: call.title,
			detail: call.detail,
		});
		expect(call.title).toBe("Allow this tool to run?");
	});

	it("specKind echoes the spec kind", () => {
		expect(specKind({ kind: "bash", command: "ls" })).toBe("bash");
		expect(specKind({ kind: "other", toolName: "t", input: {} })).toBe("other");
	});
});
