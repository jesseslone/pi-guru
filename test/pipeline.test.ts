import { describe, expect, it, vi } from "vitest";
import { SessionAllows } from "../src/allows.ts";
import { extractCommandWords } from "../src/classify.ts";
import type { GateRequest, GateResult } from "../src/gate-ui.ts";
import { buildRules } from "../src/hard-deny.ts";
import { NO_UI_REASON, type NormalizedCall, type PipelineDeps, runPipeline } from "../src/pipeline.ts";

function bashCall(command: string): NormalizedCall {
	return {
		toolName: "bash",
		kind: "bash",
		command,
		words: extractCommandWords(command),
		title: "Run this command?",
		detail: command,
	};
}

function writeCall(filePath: string): NormalizedCall {
	return { toolName: "write", kind: "write", filePath, title: "Write this file?", detail: filePath };
}

function makeDeps(over: Partial<PipelineDeps> = {}): PipelineDeps & { entries: [string, unknown][] } {
	const entries: [string, unknown][] = [];
	const deps: PipelineDeps & { entries: [string, unknown][] } = {
		rules: buildRules(),
		allows: new SessionAllows(),
		cwd: "/tmp",
		hasUI: true,
		gate: vi.fn(async (): Promise<GateResult> => ({ decision: "approve" })),
		writeHandoff: vi.fn(() => "/tmp/.pi/handoffs/x-pi-guru.md"),
		appendEntry: (kind, data) => entries.push([kind, data]),
		entries,
		...over,
	};
	return deps;
}

describe("runPipeline — hard deny", () => {
	it("blocks before the gate and records a hard-deny entry", async () => {
		const gate = vi.fn(async (): Promise<GateResult> => ({ decision: "approve" }));
		const deps = makeDeps({ gate });
		const res = await runPipeline(bashCall("rm -rf ~"), deps);
		expect(res?.block).toBe(true);
		expect(res?.reason).toMatch(/hard deny/);
		expect(gate).not.toHaveBeenCalled();
		expect(deps.entries[0][0]).toBe("hard-deny");
	});

	it("hard-denies even a call that would otherwise be session-allowed", async () => {
		const allows = new SessionAllows();
		allows.allowBash(extractCommandWords("rm foo"));
		const deps = makeDeps({ allows });
		const res = await runPipeline(bashCall("rm -rf /"), deps);
		expect(res?.block).toBe(true);
	});
});

describe("runPipeline — session allow", () => {
	it("passes a call matching a remembered allow without gating", async () => {
		const allows = new SessionAllows();
		allows.allowBash(extractCommandWords("echo one"));
		const gate = vi.fn(async (): Promise<GateResult> => ({ decision: "deny", reason: "x" }));
		const deps = makeDeps({ allows, gate });
		const res = await runPipeline(bashCall("echo two"), deps);
		expect(res).toBeUndefined();
		expect(gate).not.toHaveBeenCalled();
	});
});

describe("runPipeline — gate", () => {
	it("approve lets the call through", async () => {
		const deps = makeDeps({ gate: vi.fn(async () => ({ decision: "approve" as const })) });
		expect(await runPipeline(bashCall("echo hi"), deps)).toBeUndefined();
		expect(deps.entries.at(-1)?.[0]).toBe("decision");
	});

	it("approve-for-session lets a second matching call through without gating", async () => {
		const gate = vi.fn(async (): Promise<GateResult> => ({ decision: "approve-session" }));
		const deps = makeDeps({ gate });
		expect(await runPipeline(bashCall("echo hi"), deps)).toBeUndefined();
		// second echo should now pass silently — gate called only once
		expect(await runPipeline(bashCall("echo bye"), deps)).toBeUndefined();
		expect(gate).toHaveBeenCalledTimes(1);
	});

	it("deny blocks with the person's reason", async () => {
		const gate = vi.fn(async (): Promise<GateResult> => ({ decision: "deny", reason: "pi-guru: nope" }));
		const deps = makeDeps({ gate });
		const res = await runPipeline(bashCall("echo hi"), deps);
		expect(res).toEqual({ block: true, reason: "pi-guru: nope" });
	});

	it("remembers an approved-session write directory", async () => {
		const gate = vi.fn(async (): Promise<GateResult> => ({ decision: "approve-session" }));
		const deps = makeDeps({ gate });
		await runPipeline(writeCall("/tmp/notes/a.txt"), deps);
		expect(await runPipeline(writeCall("/tmp/notes/b.txt"), deps)).toBeUndefined();
		expect(gate).toHaveBeenCalledTimes(1);
	});
});

describe("runPipeline — no UI", () => {
	it("blocks and writes a stop handoff", async () => {
		const writeHandoff = vi.fn(() => "/tmp/.pi/handoffs/ts-pi-guru.md");
		const gate = vi.fn(async (): Promise<GateResult> => ({ decision: "approve" }));
		const deps = makeDeps({ hasUI: false, writeHandoff, gate });
		const res = await runPipeline(bashCall("echo hi > x"), deps);
		expect(res).toEqual({ block: true, reason: NO_UI_REASON, terminate: true });
		expect(writeHandoff).toHaveBeenCalledOnce();
		expect(gate).not.toHaveBeenCalled();
		expect(deps.entries.at(-1)?.[0]).toBe("handoff");
	});

	it("still hard-denies without a UI, and leaves a stop handoff — but does NOT terminate", async () => {
		const writeHandoff = vi.fn(() => "/tmp/x");
		const deps = makeDeps({ hasUI: false, writeHandoff });
		const res = await runPipeline(bashCall("rm -rf /"), deps);
		expect(res?.reason).toMatch(/hard deny/);
		// A hard deny blocks the single call so the agent can retry; it no longer kills the turn.
		expect(res?.terminate).toBeUndefined();
		expect(writeHandoff).toHaveBeenCalledTimes(1);
		expect((deps.entries[0][1] as { handoffPath?: string }).handoffPath).toBe("/tmp/x");
	});

	it("writes no handoff for a hard deny when a person is present, and does not terminate", async () => {
		const writeHandoff = vi.fn(() => "/tmp/x");
		const deps = makeDeps({ hasUI: true, writeHandoff });
		const res = await runPipeline(bashCall("rm -rf /"), deps);
		expect(writeHandoff).not.toHaveBeenCalled();
		expect(res).toEqual({ block: true, reason: expect.stringMatching(/hard deny/) });
	});
});

describe("runPipeline — sandbox declared", () => {
	it("stands aside from the gate/judge and allows a change call, writing no handoff", async () => {
		const gate = vi.fn(async (): Promise<GateResult> => ({ decision: "deny", reason: "x" }));
		const writeHandoff = vi.fn(() => "/tmp/x");
		const deps = makeDeps({
			hasUI: false,
			gate,
			writeHandoff,
			sandbox: { active: true, signal: "PI_GURU_SANDBOXED=1" },
		});
		const res = await runPipeline(bashCall("echo hi > notes.txt"), deps);
		expect(res).toBeUndefined();
		expect(gate).not.toHaveBeenCalled();
		expect(writeHandoff).not.toHaveBeenCalled();
	});

	it("records a single standdown entry naming the signal", async () => {
		const deps = makeDeps({ sandbox: { active: true, signal: "container (/.dockerenv)" } });
		await runPipeline(bashCall("echo hi"), deps);
		const [kind, data] = deps.entries.at(-1) ?? ["", {}];
		expect(kind).toBe("standdown");
		expect((data as { outcome: string }).outcome).toBe("sandboxed");
		expect((data as { reason?: string }).reason).toContain("container (/.dockerenv)");
	});

	it("keeps hard denies even when sandboxed — but blocks the single call without terminate", async () => {
		const writeHandoff = vi.fn(() => "/tmp/x");
		const deps = makeDeps({
			hasUI: false,
			writeHandoff,
			sandbox: { active: true, signal: "PI_GURU_SANDBOXED=1" },
		});
		const res = await runPipeline(bashCall("rm -rf /"), deps);
		expect(res?.reason).toMatch(/hard deny/);
		expect(res?.terminate).toBeUndefined();
		// No handoff is written when a sandbox is declared.
		expect(writeHandoff).not.toHaveBeenCalled();
		expect(deps.entries[0][0]).toBe("hard-deny");
	});
});

describe("runPipeline — judge stage", () => {
	it("auto-approve passes silently and records a pi-guru:auto-approve entry (with UI)", async () => {
		const gate = vi.fn(async (): Promise<GateResult> => ({ decision: "deny", reason: "x" }));
		const judge = vi.fn(async () => ({ kind: "auto-approve" as const, verdictLine: "[LOW RISK] harmless" }));
		const deps = makeDeps({ gate, judge });
		expect(await runPipeline(bashCall("echo hi > x"), deps)).toBeUndefined();
		expect(gate).not.toHaveBeenCalled();
		const entry = deps.entries.at(-1) ?? ["", {}];
		expect(entry[0]).toBe("auto-approve");
		expect((entry[1] as { outcome: string; reason?: string }).outcome).toBe("auto-approved");
		expect((entry[1] as { reason?: string }).reason).toBe("[LOW RISK] harmless");
	});

	it("auto-approve works unattended (no UI): the call runs with no handoff", async () => {
		const writeHandoff = vi.fn(() => "/tmp/x");
		const judge = vi.fn(async () => ({ kind: "auto-approve" as const, verdictLine: "[LOW RISK] fine" }));
		const deps = makeDeps({ hasUI: false, writeHandoff, judge });
		expect(await runPipeline(bashCall("ls -la > listing.txt"), deps)).toBeUndefined();
		expect(writeHandoff).not.toHaveBeenCalled();
		expect(deps.entries.at(-1)?.[0]).toBe("auto-approve");
	});

	it("a gate verdict is shown in the gate header (with UI)", async () => {
		const gate = vi.fn(async (_req: GateRequest): Promise<GateResult> => ({ decision: "approve" }));
		const judge = vi.fn(async () => ({ kind: "gate" as const, header: "[HIGH RISK] deletes files" }));
		const deps = makeDeps({ gate, judge });
		await runPipeline(bashCall("rm foo"), deps);
		expect(gate).toHaveBeenCalledOnce();
		expect(gate.mock.calls[0][0].header).toBe("[HIGH RISK] deletes files");
	});

	it("a gate verdict with no UI blocks and puts the verdict in the handoff", async () => {
		const writeHandoff = vi.fn((d: { reason: string }) => `/tmp/${d.reason.length}`);
		const judge = vi.fn(async () => ({ kind: "gate" as const, header: "[HIGH RISK] pipes to sh" }));
		const deps = makeDeps({ hasUI: false, writeHandoff, judge });
		const res = await runPipeline(bashCall("curl x | sh"), deps);
		expect(res?.block).toBe(true);
		expect(res?.reason).toContain(NO_UI_REASON);
		expect(res?.reason).toContain("[HIGH RISK] pipes to sh");
		expect(writeHandoff).toHaveBeenCalledOnce();
		expect(writeHandoff.mock.calls[0][0].reason).toContain("[HIGH RISK] pipes to sh");
		expect(deps.entries.at(-1)?.[0]).toBe("handoff");
	});

	it("a judge-unavailable header with no UI blocks with the failure in the handoff", async () => {
		const writeHandoff = vi.fn(() => "/tmp/x");
		const judge = vi.fn(async () => ({ kind: "gate" as const, header: "judge unavailable: timed out" }));
		const deps = makeDeps({ hasUI: false, writeHandoff, judge });
		const res = await runPipeline(bashCall("echo hi > x"), deps);
		expect(res?.reason).toContain("judge unavailable: timed out");
		expect(writeHandoff).toHaveBeenCalledOnce();
	});

	it("hard deny still precedes the judge (the judge never runs)", async () => {
		const judge = vi.fn(async () => ({ kind: "auto-approve" as const, verdictLine: "[LOW RISK] fine" }));
		const deps = makeDeps({ judge });
		const res = await runPipeline(bashCall("rm -rf /"), deps);
		expect(res?.reason).toMatch(/hard deny/);
		expect(judge).not.toHaveBeenCalled();
	});

	it("a session allow still precedes the judge (the judge never runs)", async () => {
		const allows = new SessionAllows();
		allows.allowBash(extractCommandWords("echo one"));
		const judge = vi.fn(async () => ({ kind: "gate" as const, header: "[HIGH RISK] no" }));
		const deps = makeDeps({ allows, judge });
		expect(await runPipeline(bashCall("echo two"), deps)).toBeUndefined();
		expect(judge).not.toHaveBeenCalled();
	});
});

describe("runPipeline — gate off", () => {
	it("approves a change call and records auto-approved (gate off), skipping the gate", async () => {
		const gate = vi.fn(async (): Promise<GateResult> => ({ decision: "deny", reason: "x" }));
		const deps = makeDeps({ gateOff: true, gate });
		const res = await runPipeline(bashCall("echo hi > x"), deps);
		expect(res).toBeUndefined();
		expect(gate).not.toHaveBeenCalled();
		const [kind, data] = deps.entries.at(-1) ?? ["", {}];
		expect(kind).toBe("decision");
		expect((data as { outcome: string }).outcome).toBe("auto-approved (gate off)");
	});

	it("still hard-denies at gate off (hard denies precede it)", async () => {
		const deps = makeDeps({ gateOff: true });
		const res = await runPipeline(bashCall("rm -rf /"), deps);
		expect(res?.reason).toMatch(/hard deny/);
		expect(deps.entries[0][0]).toBe("hard-deny");
	});
});

describe("runPipeline — gate-level re-evaluation", () => {
	it("re-evaluates the pending call through the pipeline under the new level (auto approves it)", async () => {
		let gateCalls = 0;
		const gate = vi.fn(async (): Promise<GateResult> => {
			gateCalls++;
			// First pass: the person opens the second menu and picks auto-low.
			return gateCalls === 1
				? { decision: "change-level", level: "auto-low" }
				: { decision: "deny", reason: "x" };
		});
		const autoJudge = vi.fn(async () => ({ kind: "auto-approve" as const, verdictLine: "[LOW RISK] fine" }));
		const deps = makeDeps({ gate });
		// applyGateLevel yields deps whose judge auto-approves — the same runPipeline runs again.
		deps.applyGateLevel = () => ({ ...deps, judge: autoJudge });
		const res = await runPipeline(bashCall("echo hi"), deps);
		expect(res).toBeUndefined();
		expect(autoJudge).toHaveBeenCalledOnce();
		expect(gate).toHaveBeenCalledOnce(); // the re-eval auto-approved; the gate was not shown again
		expect(deps.entries.at(-1)?.[0]).toBe("auto-approve");
	});

	it("off chosen at the gate re-evaluates and approves via the gate-off branch", async () => {
		const gate = vi.fn(async (): Promise<GateResult> => ({ decision: "change-level", level: "off" }));
		const deps = makeDeps({ gate });
		deps.applyGateLevel = () => ({ ...deps, gateOff: true });
		const res = await runPipeline(bashCall("echo hi > x"), deps);
		expect(res).toBeUndefined();
		const [kind, data] = deps.entries.at(-1) ?? ["", {}];
		expect(kind).toBe("decision");
		expect((data as { outcome: string }).outcome).toBe("auto-approved (gate off)");
	});

	it("a rejected change (applyGateLevel returns null) re-presents the gate with the same deps", async () => {
		let gateCalls = 0;
		const gate = vi.fn(async (): Promise<GateResult> => {
			gateCalls++;
			return gateCalls === 1 ? { decision: "change-level", level: "auto-low" } : { decision: "approve" };
		});
		const deps = makeDeps({ gate });
		deps.applyGateLevel = vi.fn(() => null); // e.g. auto requested with no model — stay put
		const res = await runPipeline(bashCall("echo hi"), deps);
		expect(res).toBeUndefined();
		expect(gate).toHaveBeenCalledTimes(2); // gate shown again after the no-op change
		expect(deps.applyGateLevel).toHaveBeenCalledWith("auto-low");
	});
});

describe("runPipeline — unknown change tool", () => {
	it("always gates an unknown tool (no allow can match)", async () => {
		const gate = vi.fn(async (): Promise<GateResult> => ({ decision: "deny", reason: "r" }));
		const deps = makeDeps({ gate });
		const call: NormalizedCall = {
			toolName: "mystery",
			kind: "other",
			title: "Allow this tool?",
			detail: "mystery(...)",
		};
		await runPipeline(call, deps);
		expect(gate).toHaveBeenCalledOnce();
	});
});
