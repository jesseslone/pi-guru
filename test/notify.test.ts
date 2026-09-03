import { describe, expect, it } from "vitest";
import { type NotifyContext, type NotifyType, notify } from "../src/notify.ts";

/** A fake ctx that records notify calls; `mode`/`hasUI` chosen per test. */
function fakeCtx(mode: NotifyContext["mode"], hasUI: boolean) {
	const notifications: { message: string; type?: NotifyType }[] = [];
	const ctx: NotifyContext = {
		mode,
		hasUI,
		ui: { notify: (message, type) => notifications.push({ message, type }) },
	};
	return { ctx, notifications };
}

/** Capture everything written to stdout and stderr during `fn`. */
function captureStreams(fn: () => void): { stdout: string; stderr: string } {
	const out: string[] = [];
	const err: string[] = [];
	const origOut = process.stdout.write.bind(process.stdout);
	const origErr = process.stderr.write.bind(process.stderr);
	// biome-ignore lint/suspicious/noExplicitAny: narrow stream.write overrides for the test only.
	process.stdout.write = ((chunk: any) => {
		out.push(String(chunk));
		return true;
	}) as typeof process.stdout.write;
	// biome-ignore lint/suspicious/noExplicitAny: narrow stream.write overrides for the test only.
	process.stderr.write = ((chunk: any) => {
		err.push(String(chunk));
		return true;
	}) as typeof process.stderr.write;
	try {
		fn();
	} finally {
		process.stdout.write = origOut;
		process.stderr.write = origErr;
	}
	return { stdout: out.join(""), stderr: err.join("") };
}

describe("notify", () => {
	it("always speaks through ctx.ui.notify", () => {
		const { ctx, notifications } = fakeCtx("print", false);
		captureStreams(() => notify(ctx, "pi-guru: hello", "info"));
		expect(notifications).toEqual([{ message: "pi-guru: hello", type: "info" }]);
	});

	it("without a UI, writes info/warning to stdout, prefixed as given", () => {
		const { ctx } = fakeCtx("print", false);
		const { stdout, stderr } = captureStreams(() => notify(ctx, "pi-guru-bench: heads up", "warning"));
		expect(stdout).toBe("pi-guru-bench: heads up\n");
		expect(stderr).toBe("");
	});

	it("without a UI, writes errors to stderr", () => {
		const { ctx } = fakeCtx("print", false);
		const { stdout, stderr } = captureStreams(() => notify(ctx, "pi-guru: nope", "error"));
		expect(stderr).toBe("pi-guru: nope\n");
		expect(stdout).toBe("");
	});

	it("json mode writes to a stream even though hasUI could be false", () => {
		const { ctx } = fakeCtx("json", false);
		const { stdout } = captureStreams(() => notify(ctx, "pi-guru: json", "info"));
		expect(stdout).toBe("pi-guru: json\n");
	});

	it("TUI mode prints nothing extra — notify only", () => {
		const { ctx, notifications } = fakeCtx("tui", true);
		const { stdout, stderr } = captureStreams(() => notify(ctx, "pi-guru: tui", "error"));
		expect(stdout).toBe("");
		expect(stderr).toBe("");
		expect(notifications).toEqual([{ message: "pi-guru: tui", type: "error" }]);
	});

	it("RPC mode prints nothing extra — notify only", () => {
		const { ctx } = fakeCtx("rpc", true);
		const { stdout, stderr } = captureStreams(() => notify(ctx, "pi-guru: rpc", "warning"));
		expect(stdout).toBe("");
		expect(stderr).toBe("");
	});

	it("defaults the type to info", () => {
		const { ctx, notifications } = fakeCtx("print", false);
		const { stdout } = captureStreams(() => notify(ctx, "pi-guru: default"));
		expect(stdout).toBe("pi-guru: default\n");
		expect(notifications).toEqual([{ message: "pi-guru: default", type: "info" }]);
	});
});
