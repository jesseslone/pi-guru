import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	loadConfigFile,
	loadEffectiveConfig,
	mergeConfigs,
	type PiGuruConfig,
	parseConfig,
	setJudgeInConfig,
	setLevelInConfig,
} from "../src/config.ts";

describe("parseConfig", () => {
	it("defaults empty on junk, with the default explanation level and judge advise", () => {
		expect(parseConfig(null)).toEqual({
			readOnlyTools: [],
			hardDeny: [],
			level: "intermediate",
			judgeMode: "advise",
			judgeThreshold: "low",
			judgeLayout: "current",
			judgePrompt: "v1",
			judgeFacts: true,
		});
		expect(parseConfig({ readOnlyTools: "nope", hardDeny: 3 })).toEqual({
			readOnlyTools: [],
			hardDeny: [],
			level: "intermediate",
			judgeMode: "advise",
			judgeThreshold: "low",
			judgeLayout: "current",
			judgePrompt: "v1",
			judgeFacts: true,
		});
	});

	it("keeps only string entries", () => {
		expect(parseConfig({ readOnlyTools: ["a", 1, "b"], hardDeny: ["x"] })).toEqual({
			readOnlyTools: ["a", "b"],
			hardDeny: ["x"],
			level: "intermediate",
			judgeMode: "advise",
			judgeThreshold: "low",
			judgeLayout: "current",
			judgePrompt: "v1",
			judgeFacts: true,
		});
	});
	it("reads a valid level and ignores an invalid one", () => {
		expect(parseConfig({ level: "technical" }).level).toBe("technical");
		expect(parseConfig({ level: "loud" }).level).toBe("intermediate");
	});
	it("reads a valid judge mode and threshold, ignoring invalid ones", () => {
		expect(parseConfig({ judgeMode: "auto", judgeThreshold: "medium" })).toMatchObject({
			judgeMode: "auto",
			judgeThreshold: "medium",
		});
		expect(parseConfig({ judgeMode: "yolo", judgeThreshold: "high" })).toMatchObject({
			judgeMode: "advise",
			judgeThreshold: "low",
		});
	});
	it("defaults judgePrompt to v1, reads v2, and ignores an unknown version", () => {
		expect(parseConfig({}).judgePrompt).toBe("v1");
		expect(parseConfig({ judgePrompt: "v2" }).judgePrompt).toBe("v2");
		expect(parseConfig({ judgePrompt: "v9" }).judgePrompt).toBe("v1");
	});
});

describe("mergeConfigs — tighten only", () => {
	const full = (over: Partial<PiGuruConfig>): PiGuruConfig => ({
		readOnlyTools: [],
		hardDeny: [],
		level: "intermediate",
		judgeMode: "off",
		judgeThreshold: "low",
		judgeLayout: "current",
		judgePrompt: "v1",
		judgeFacts: true,
		...over,
	});

	const global: PiGuruConfig = full({
		readOnlyTools: ["web_search", "docs_lookup"],
		hardDeny: ["\\bfoo\\b"],
		level: "fundamental",
		judgeMode: "auto",
		judgeThreshold: "medium",
	});

	it("returns global when there is no project config", () => {
		expect(mergeConfigs(global, undefined)).toEqual(global);
	});

	it("lets the project shrink the read-only set (gate more)", () => {
		const project = full({ readOnlyTools: ["web_search"], judgeMode: "auto", judgeThreshold: "medium" });
		expect(mergeConfigs(global, project).readOnlyTools).toEqual(["web_search"]);
	});

	it("does not let the project add a read-only tool", () => {
		const project = full({
			readOnlyTools: ["web_search", "docs_lookup", "shell_exec"],
			judgeMode: "auto",
			judgeThreshold: "medium",
		});
		expect(mergeConfigs(global, project).readOnlyTools.sort()).toEqual(["docs_lookup", "web_search"]);
	});

	it("unions hard-deny rules and never drops one", () => {
		const project = full({
			readOnlyTools: ["web_search", "docs_lookup"],
			hardDeny: ["\\bbar\\b"],
			judgeMode: "auto",
			judgeThreshold: "medium",
		});
		expect(mergeConfigs(global, project).hardDeny.sort()).toEqual(["\\bbar\\b", "\\bfoo\\b"]);
	});

	it("keeps the global level: a project may not change the explanation level", () => {
		const project = full({
			readOnlyTools: ["web_search", "docs_lookup"],
			level: "technical",
			judgeMode: "auto",
		});
		expect(mergeConfigs(global, project).level).toBe("fundamental");
	});

	it("keeps the global judge layout: a project may not change it", () => {
		const globalStable = full({ judgeLayout: "prefix-stable" });
		const project = full({ judgeLayout: "shared-prefix" });
		expect(mergeConfigs(globalStable, project).judgeLayout).toBe("prefix-stable");
	});

	it("keeps the global judge prompt version: a project may not change it", () => {
		const globalV2 = full({ judgePrompt: "v2" });
		const project = full({ judgePrompt: "v1" });
		expect(mergeConfigs(globalV2, project).judgePrompt).toBe("v2");
	});

	it("lets a project tighten the judge mode (auto → advise) but not raise it", () => {
		const advise = full({
			readOnlyTools: ["web_search", "docs_lookup"],
			judgeMode: "advise",
			judgeThreshold: "medium",
		});
		expect(mergeConfigs(global, advise).judgeMode).toBe("advise");
		// A global of advise cannot be raised to auto by a project.
		const globalAdvise = full({ judgeMode: "advise" });
		const wantsAuto = full({ judgeMode: "auto" });
		expect(mergeConfigs(globalAdvise, wantsAuto).judgeMode).toBe("advise");
	});

	it("lets a project turn the judge off", () => {
		const off = full({
			readOnlyTools: ["web_search", "docs_lookup"],
			judgeMode: "off",
			judgeThreshold: "medium",
		});
		expect(mergeConfigs(global, off).judgeMode).toBe("off");
	});

	it("lets a project lower the threshold (medium → low) but not raise it", () => {
		const lower = full({
			readOnlyTools: ["web_search", "docs_lookup"],
			judgeMode: "auto",
			judgeThreshold: "low",
		});
		expect(mergeConfigs(global, lower).judgeThreshold).toBe("low");
		const globalLow = full({ judgeMode: "auto", judgeThreshold: "low" });
		const wantsMedium = full({ judgeMode: "auto", judgeThreshold: "medium" });
		expect(mergeConfigs(globalLow, wantsMedium).judgeThreshold).toBe("low");
	});
});

describe("loadConfigFile / loadEffectiveConfig", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-guru-config-"));

	it("returns undefined for a missing file", () => {
		expect(loadConfigFile(join(dir, "nope.json"))).toBeUndefined();
	});

	it("returns undefined for malformed JSON", () => {
		const p = join(dir, "bad.json");
		writeFileSync(p, "{ not json");
		expect(loadConfigFile(p)).toBeUndefined();
	});

	it("loads and merges global + project with tighten-only, keeping the global level", () => {
		const g = join(dir, "global.json");
		const p = join(dir, "project.json");
		writeFileSync(
			g,
			JSON.stringify({
				readOnlyTools: ["web_search", "docs_lookup"],
				hardDeny: ["\\bfoo\\b"],
				level: "technical",
			}),
		);
		writeFileSync(
			p,
			JSON.stringify({ readOnlyTools: ["web_search", "extra_tool"], hardDeny: ["\\bbar\\b"], level: "off" }),
		);
		const eff = loadEffectiveConfig(g, p, true);
		expect(eff.readOnlyTools).toEqual(["web_search"]);
		expect(eff.hardDeny.sort()).toEqual(["\\bbar\\b", "\\bfoo\\b"]);
		expect(eff.level).toBe("technical");
	});

	it("ignores the project config entirely when the project is not trusted", () => {
		const g = join(dir, "global-untrusted.json");
		const p = join(dir, "project-untrusted.json");
		writeFileSync(g, JSON.stringify({ hardDeny: ["\\bfoo\\b"] }));
		writeFileSync(p, JSON.stringify({ hardDeny: ["."] }));
		// projectTrusted defaults to false: the untrusted repo adds nothing.
		expect(loadEffectiveConfig(g, p).hardDeny).toEqual(["\\bfoo\\b"]);
		expect(loadEffectiveConfig(g, p, true).hardDeny.sort()).toEqual([".", "\\bfoo\\b"]);
	});

	it("leaves the global judge alone when the project file omits the judge fields", () => {
		const g = join(dir, "g-auto.json");
		const p = join(dir, "p-omit.json");
		writeFileSync(
			g,
			JSON.stringify({ judgeMode: "auto", judgeThreshold: "medium", readOnlyTools: ["web_search"] }),
		);
		writeFileSync(p, JSON.stringify({ hardDeny: ["\\bzap\\b"] }));
		const eff = loadEffectiveConfig(g, p, true);
		expect(eff.judgeMode).toBe("auto");
		expect(eff.judgeThreshold).toBe("medium");
		expect(eff.readOnlyTools).toEqual(["web_search"]);
		expect(eff.hardDeny).toContain("\\bzap\\b");
	});

	it("defaults when the global file is absent (intermediate level, judge advise)", () => {
		expect(loadEffectiveConfig(join(dir, "none.json"))).toEqual({
			readOnlyTools: [],
			hardDeny: [],
			level: "intermediate",
			judgeMode: "advise",
			judgeThreshold: "low",
			judgeLayout: "current",
			judgePrompt: "v1",
			judgeFacts: true,
		});
	});

	it("lets a project tighten the judge while a global enables auto/medium", () => {
		const g = join(dir, "global-judge.json");
		const p = join(dir, "project-judge.json");
		writeFileSync(g, JSON.stringify({ judgeMode: "auto", judgeThreshold: "medium" }));
		writeFileSync(p, JSON.stringify({ judgeMode: "advise", judgeThreshold: "low" }));
		const eff = loadEffectiveConfig(g, p, true);
		expect(eff.judgeMode).toBe("advise");
		expect(eff.judgeThreshold).toBe("low");
	});
});

describe("setLevelInConfig", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-guru-setlevel-"));

	it("creates the file and persists the level", () => {
		const p = join(dir, "nested", "pi-guru.json");
		setLevelInConfig(p, "fundamental");
		expect(loadEffectiveConfig(p).level).toBe("fundamental");
	});

	it("preserves other fields when changing the level", () => {
		const p = join(dir, "keep.json");
		writeFileSync(
			p,
			JSON.stringify({ readOnlyTools: ["web_search"], hardDeny: ["\\bfoo\\b"], level: "off" }),
		);
		setLevelInConfig(p, "technical");
		const raw = JSON.parse(readFileSync(p, "utf8"));
		expect(raw).toEqual({ readOnlyTools: ["web_search"], hardDeny: ["\\bfoo\\b"], level: "technical" });
	});
});

describe("setJudgeInConfig", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-guru-setjudge-"));

	it("creates the file and persists mode and threshold", () => {
		const p = join(dir, "nested", "pi-guru.json");
		setJudgeInConfig(p, "auto", "medium");
		const eff = loadEffectiveConfig(p);
		expect(eff.judgeMode).toBe("auto");
		expect(eff.judgeThreshold).toBe("medium");
	});

	it("preserves other fields when changing the judge", () => {
		const p = join(dir, "keep.json");
		writeFileSync(p, JSON.stringify({ readOnlyTools: ["web_search"], level: "off" }));
		setJudgeInConfig(p, "advise", "low");
		const raw = JSON.parse(readFileSync(p, "utf8"));
		expect(raw).toEqual({
			readOnlyTools: ["web_search"],
			level: "off",
			judgeMode: "advise",
			judgeThreshold: "low",
		});
	});
});
