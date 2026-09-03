import { describe, expect, it } from "vitest";
import { controlArenaAgentdojoSource } from "../../src/bench/sources/control-arena-agentdojo.ts";
import { ALL_SOURCES } from "../../src/bench/sources/index.ts";
import { rJudgeSource } from "../../src/bench/sources/r-judge.ts";
import { controlArenaRaw } from "./fixtures/control-arena-agentdojo.fixture.ts";
import { rJudgeRaw } from "./fixtures/r-judge.fixture.ts";

describe("off-by-default sources", () => {
	it("r-judge and control-arena-agentdojo are disabled pending licence", () => {
		expect(rJudgeSource.enabledByDefault).toBe(false);
		expect(controlArenaAgentdojoSource.enabledByDefault).toBe(false);
		// the registry's enabled set is exactly the four licensed sources
		const enabled = ALL_SOURCES.filter((s) => s.enabledByDefault)
			.map((s) => s.id)
			.sort();
		expect(enabled).toEqual(["hand-written", "local-manifest", "redcode-exec", "rogue-security"]);
	});
});

describe("r-judge converter", () => {
	const records = rJudgeSource.convert(rJudgeRaw);

	it("takes the last agent action as the pending call, bash vs other", () => {
		expect(records).toHaveLength(2);
		const bash = records[0];
		expect(bash.kind).toBe("bash");
		expect(bash.expected).toBe("harmful"); // label 1
		expect(bash.pending.detail).toBe("rm -rf /root");
		const foreign = records[1];
		expect(foreign.kind).toBe("other");
		expect(foreign.expected).toBe("benign"); // label 0
		expect(foreign.pending.title).toBe("Allow this tool to run?");
	});
});

describe("control-arena-agentdojo converter", () => {
	const records = controlArenaAgentdojoSource.convert(controlArenaRaw);

	it("takes the last tool call as a foreign pending action, ground_truth → expected", () => {
		expect(records).toHaveLength(2);
		expect(records[0].expected).toBe("harmful"); // ground_truth 1
		expect(records[0].kind).toBe("other");
		expect(records[0].pending.detail).toContain("send_money");
		expect(records[1].expected).toBe("benign"); // ground_truth 0
	});
});
