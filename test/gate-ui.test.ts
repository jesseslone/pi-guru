import { describe, expect, it, vi } from "vitest";
import type { ExplainStep } from "../src/explain.ts";
import { type Explainer, type GateContext, gateItems, presentGate } from "../src/gate-ui.ts";

/** A fake ctx that scripts the person's choice through ctx.ui.select and ctx.ui.input. */
function fakeCtx(opts: { pick?: string; reason?: string }): GateContext {
	return {
		mode: "rpc",
		ui: {
			select: vi.fn(async () => opts.pick),
			input: vi.fn(async () => opts.reason),
		},
	} as unknown as GateContext;
}

/** A fake ctx that returns a scripted sequence of picks and records dialog titles/labels. */
function seqCtx(picks: (string | undefined)[]) {
	const titles: string[] = [];
	const labelSets: string[][] = [];
	let i = 0;
	const ctx = {
		mode: "rpc",
		ui: {
			select: vi.fn(async (title: string, labels: string[]) => {
				titles.push(title);
				labelSets.push(labels);
				return picks[i++];
			}),
			input: vi.fn(async () => undefined),
			notify: vi.fn(),
		},
	} as unknown as GateContext & { ui: { notify: ReturnType<typeof vi.fn> } };
	return { ctx, titles, labelSets };
}

const okStep = (markdown: string): Explainer =>
	vi.fn(
		async (): Promise<ExplainStep> => ({
			ok: true,
			level: "intermediate",
			markdown,
			usage: { totalTokens: 5 } as never,
		}),
	);

describe("gateItems", () => {
	it("offers the four slice-1 choices with Approve first, no Explain by default", () => {
		const values = gateItems().map((i) => i.value);
		expect(values).toEqual(["approve", "approve-session", "deny", "deny-reason"]);
	});

	it("prepends Explain as the first choice when Explain is offered", () => {
		const items = gateItems(true, "fundamental");
		expect(items[0].value).toBe("explain");
		expect(items[0].description).toContain("fundamental");
	});
});

describe("presentGate — Explain", () => {
	const request = { title: "Run this command?", detail: "rm build/" };

	it("shows an explanation then approves; the explanation appears in the reprompt", async () => {
		const { ctx, titles, labelSets } = seqCtx(["Explain", "Approve"]);
		const explainer = okStep("This deletes the build output folder.");
		const res = await presentGate(ctx, request, { explainer, startLevel: "intermediate" });
		expect(res).toEqual({ decision: "approve" });
		expect(explainer).toHaveBeenCalledOnce();
		expect(labelSets[0]).toContain("Explain");
		expect(titles[1]).toContain("This deletes the build output folder.");
	});

	it("steps deeper on a second Explain, then denies", async () => {
		const { ctx } = seqCtx(["Explain", "Explain", "Deny"]);
		const explainer = okStep("deeper");
		const res = await presentGate(ctx, request, { explainer, startLevel: "fundamental" });
		expect(res).toEqual({ decision: "deny", reason: "pi-guru: denied at the gate" });
		expect(explainer).toHaveBeenCalledTimes(2);
	});

	it("notifies and keeps the gate open when an explanation fails", async () => {
		const { ctx } = seqCtx(["Explain", "Approve"]);
		const explainer = vi.fn(async (): Promise<ExplainStep> => ({ ok: false, message: "no auth" }));
		const res = await presentGate(ctx, request, { explainer, startLevel: "intermediate" });
		expect(res).toEqual({ decision: "approve" });
		const notify = (ctx as unknown as { ui: { notify: ReturnType<typeof vi.fn> } }).ui.notify;
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Explain unavailable"), "warning");
	});
});

describe("presentGate", () => {
	const request = { title: "Run this command?", detail: "echo hi" };

	it("returns approve", async () => {
		const res = await presentGate(fakeCtx({ pick: "Approve" }), request);
		expect(res).toEqual({ decision: "approve" });
	});

	it("returns approve-session", async () => {
		const res = await presentGate(fakeCtx({ pick: "Approve for this session" }), request);
		expect(res).toEqual({ decision: "approve-session" });
	});

	it("returns a plain deny", async () => {
		const res = await presentGate(fakeCtx({ pick: "Deny" }), request);
		expect(res).toEqual({ decision: "deny", reason: "pi-guru: denied at the gate" });
	});

	it("asks for a reason on deny-with-reason and surfaces it to the agent", async () => {
		const res = await presentGate(fakeCtx({ pick: "Deny with a reason", reason: "not now" }), request);
		expect(res).toEqual({ decision: "deny", reason: "pi-guru: not now" });
	});

	it("falls back to a generic reason when the person gives none", async () => {
		const res = await presentGate(fakeCtx({ pick: "Deny with a reason", reason: "  " }), request);
		expect(res).toEqual({ decision: "deny", reason: "pi-guru: denied at the gate" });
	});

	it("treats a cancelled/timed-out dialog as deny (fail-safe)", async () => {
		const res = await presentGate(fakeCtx({ pick: undefined }), request);
		expect(res).toEqual({ decision: "deny", reason: "pi-guru: denied at the gate" });
	});
});
