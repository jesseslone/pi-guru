import { describe, expect, it } from "vitest";
import { fenceUntrusted } from "../src/fence.ts";

describe("fenceUntrusted", () => {
	it("wraps every section between a shared per-message nonce marker", () => {
		const text = fenceUntrusted("Do the thing.", [
			{ label: "pending action", content: "rm -rf build" },
			{ label: "conversation so far", content: "User: clean up" },
		]);
		expect(text).toContain("Do the thing.");
		expect(text).toContain("rm -rf build");
		expect(text).toContain("User: clean up");
		expect(text).toContain("[pending action]");
		expect(text).toContain("[conversation so far]");
		// A single open/close pair, matched by nonce, brackets all the untrusted content.
		const open = text.match(/<<UNTRUSTED-([A-Za-z0-9_-]+)>>/);
		const close = text.match(/<<END-UNTRUSTED-([A-Za-z0-9_-]+)>>/);
		expect(open).not.toBeNull();
		expect(close).not.toBeNull();
		expect(open?.[1]).toBe(close?.[1]);
		// The content sits inside the fence: an open marker precedes it, a close marker follows it.
		// (The preamble names both markers too, so use the last close marker — the real fence end.)
		expect(text.indexOf("<<UNTRUSTED-")).toBeLessThan(text.indexOf("rm -rf build"));
		expect(text.lastIndexOf("<<END-UNTRUSTED-")).toBeGreaterThan(text.indexOf("User: clean up"));
	});

	it("uses a fresh, unpredictable nonce each call, so content cannot forge the fence", () => {
		const nonceOf = (s: string) => s.match(/<<UNTRUSTED-([A-Za-z0-9_-]+)>>/)?.[1];
		const a = nonceOf(fenceUntrusted("x", [{ label: "a", content: "1" }]));
		const b = nonceOf(fenceUntrusted("x", [{ label: "a", content: "1" }]));
		expect(a).toBeTruthy();
		expect(a).not.toBe(b);
	});

	it("frames the block as untrusted data, not instructions", () => {
		const text = fenceUntrusted("Judge it.", [{ label: "pending action", content: "echo hi" }]);
		expect(text.toLowerCase()).toContain("data, not instructions");
	});
});
