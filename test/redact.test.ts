import { describe, expect, it } from "vitest";
import { redactSecrets } from "../src/redact.ts";

describe("redactSecrets", () => {
	it("redacts a Bearer token in an Authorization header", () => {
		const out = redactSecrets("curl -H 'Authorization: Bearer sk-SECRET' https://api.x/deploy");
		expect(out).not.toContain("sk-SECRET");
		expect(out).toContain("[redacted]");
		// the surrounding command is preserved
		expect(out).toContain("curl");
		expect(out).toContain("https://api.x/deploy");
	});

	it("redacts a non-Bearer Authorization header value", () => {
		const out = redactSecrets("curl -H 'Authorization: Basic abc123def==' https://x");
		expect(out).not.toContain("abc123def");
		expect(out).toContain("[redacted]");
	});

	it("redacts token= and password= query/assignment values", () => {
		expect(redactSecrets("curl 'https://x?token=abc123'")).toBe("curl 'https://x?token=[redacted]'");
		expect(redactSecrets("mysql --user root password=hunter2")).not.toContain("hunter2");
	});

	it("redacts the value after --password (space or =)", () => {
		expect(redactSecrets("mysql --password hunter2 db")).toContain("--password [redacted]");
		expect(redactSecrets("mysql --password=hunter2 db")).toContain("--password=[redacted]");
	});

	it("redacts common key shapes: sk-, ghp_, and AWS access key ids", () => {
		expect(redactSecrets("export KEY=sk-ant-abc123DEF_-")).not.toContain("sk-ant-abc123");
		expect(redactSecrets("gh auth login --with-token ghp_ABCDEF0123456789")).not.toContain("ghp_ABCDEF");
		expect(redactSecrets("aws configure AKIAIOSFODNN7EXAMPLE")).not.toContain("AKIAIOSFODNN7EXAMPLE");
	});

	it("leaves an ordinary command untouched", () => {
		expect(redactSecrets("echo hi > notes.txt")).toBe("echo hi > notes.txt");
	});
});
