import { describe, expect, it } from "vitest";
import { sample } from "../../src/bench/sample.ts";
import type { BenchRecord } from "../../src/bench/schema.ts";

function rec(id: string): BenchRecord {
	return {
		source: "s",
		sourceVersion: "v",
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

const records = Array.from({ length: 50 }, (_, i) => rec(`id-${i}`));

describe("sample", () => {
	it("is deterministic for a given seed and limit", () => {
		const a = sample(records, { seed: 7, limit: 10 });
		const b = sample(records, { seed: 7, limit: 10 });
		expect(a.map((r) => r.id)).toEqual(b.map((r) => r.id));
		expect(a).toHaveLength(10);
	});

	it("is stable regardless of input order (keys on seed + id)", () => {
		const shuffled = [...records].reverse();
		const a = sample(records, { seed: "abc", limit: 8 });
		const b = sample(shuffled, { seed: "abc", limit: 8 });
		expect(new Set(a.map((r) => r.id))).toEqual(new Set(b.map((r) => r.id)));
	});

	it("different seeds generally select different subsets", () => {
		const a = sample(records, { seed: 1, limit: 10 }).map((r) => r.id);
		const b = sample(records, { seed: 2, limit: 10 }).map((r) => r.id);
		expect(a).not.toEqual(b);
	});

	it("keeps everything (ordered) when limit is absent or >= size", () => {
		expect(sample(records, { seed: 1 })).toHaveLength(50);
		expect(sample(records, { seed: 1, limit: 999 })).toHaveLength(50);
		expect(sample(records, { seed: 1, limit: 0 })).toHaveLength(50);
	});

	it("applies the limit per source, so a large source cannot crowd out a small one", () => {
		const big = Array.from({ length: 50 }, (_, i) => ({ ...records[0], id: `big/${i}`, source: "big" }));
		const small = Array.from({ length: 5 }, (_, i) => ({ ...records[0], id: `small/${i}`, source: "small" }));
		const out = sample([...big, ...small], { seed: 1, limit: 10 });
		expect(out.filter((r) => r.source === "big")).toHaveLength(10);
		expect(out.filter((r) => r.source === "small")).toHaveLength(5);
	});
});
