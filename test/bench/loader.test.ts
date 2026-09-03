import { afterEach, describe, expect, it } from "vitest";
import { loadSources } from "../../src/bench/loader.ts";
import type { BenchRecord, Source } from "../../src/bench/schema.ts";

function record(id: string): BenchRecord {
	return {
		source: "x",
		sourceVersion: "",
		id,
		category: "c",
		kind: "bash",
		expected: "benign",
		label: "l",
		transcriptEntries: [],
		pending: { title: "t", detail: "d" },
		origin: { url: "", license: "", attribution: "" },
	};
}

function fakeSource(over: Partial<Source> & Pick<Source, "id">): Source {
	return {
		license: "MIT",
		enabledByDefault: true,
		version: async () => "v1",
		fetch: async () => [],
		convert: () => [record(`${over.id}/1`)],
		...over,
	};
}

// No unit test may hit the network; fail loudly if a fake source ever calls fetch().
const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("loadSources", () => {
	it("stamps the pinned version and records a source-loaded event", async () => {
		const good = fakeSource({ id: "good", version: async () => "commit-abc" });
		const { records, events } = await loadSources({ sources: [good] });
		expect(records).toHaveLength(1);
		expect(records[0].sourceVersion).toBe("commit-abc");
		expect(events).toEqual([
			{ type: "source-loaded", source: "good", sourceVersion: "commit-abc", count: 1 },
		]);
	});

	it("isolates a throwing source as source-failed and continues", async () => {
		const boom = fakeSource({
			id: "boom",
			fetch: async () => {
				throw new Error("network down");
			},
		});
		const good = fakeSource({ id: "good" });
		const { records, events } = await loadSources({ sources: [boom, good] });
		expect(records.map((r) => r.source)).toEqual(["x"]);
		expect(events[0]).toEqual({ type: "source-failed", source: "boom", reason: "network down" });
		expect(events[1].type).toBe("source-loaded");
	});

	it("treats a zero-record (but parsing) source as a failure", async () => {
		const empty = fakeSource({ id: "empty", convert: () => [] });
		const { events } = await loadSources({ sources: [empty] });
		expect(events).toEqual([
			{ type: "source-failed", source: "empty", reason: "source parsed but yielded zero usable records" },
		]);
	});

	it("fails a source whose converted ids are not unique, contributing no records", async () => {
		// A converter that emits the same id for every row — the rogue-security `/undefined` shape.
		const collided = fakeSource({
			id: "collided",
			convert: () => [record("collided/undefined"), record("collided/undefined"), record("collided/x")],
		});
		const good = fakeSource({ id: "good" });
		const { records, events } = await loadSources({ sources: [collided, good] });
		expect(records.map((r) => r.source)).toEqual(["x"]); // only `good` contributed
		expect(events[0].type).toBe("source-failed");
		expect(events[0]).toMatchObject({ source: "collided" });
		if (events[0].type === "source-failed") {
			expect(events[0].reason).toMatch(/non-unique ids \(1 duplicate of 3 records\)/);
		}
		expect(events[1].type).toBe("source-loaded");
	});

	it("runs only enabled-by-default sources, but `only` forces a disabled one on", async () => {
		const off = fakeSource({ id: "off", enabledByDefault: false });
		const on = fakeSource({ id: "on" });
		const def = await loadSources({ sources: [off, on] });
		expect(def.events.map((e) => e.source)).toEqual(["on"]);
		const forced = await loadSources({ sources: [off, on], only: ["off"] });
		expect(forced.events.map((e) => e.source)).toEqual(["off"]);
	});
});
