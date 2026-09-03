/**
 * The `pi-guru-bench:result` entry renderer. Drives the real extension so the
 * renderer is registered, then renders entry data through it with a minimal fake theme — no `pi`
 * binary, no network. Asserts the collapsed header and the expanded body (report table, then the
 * generated reading or the one-line note).
 */

import { initTheme } from "@earendil-works/pi-coding-agent";
import { beforeAll, describe, expect, it } from "vitest";
import benchExtension from "../../extensions/pi-guru-bench.ts";

// The Markdown component reads the interactive theme; initialise it once so `render` works offline.
beforeAll(() => {
	try {
		initTheme();
	} catch {
		// Already initialised by another test in this process — fine.
	}
});

type Renderer = (
	entry: { data: unknown },
	state: { expanded: boolean },
	theme: unknown,
) => { render: (w: number) => string[] };

/** Capture the entry renderer the extension registers for `pi-guru-bench:result`. */
function resultRenderer(): Renderer {
	let renderer: Renderer | undefined;
	const pi = {
		registerCommand: () => {},
		registerFlag: () => {},
		getFlag: () => undefined,
		on: () => {},
		appendEntry: () => {},
		registerEntryRenderer: (kind: string, r: Renderer) => {
			if (kind === "pi-guru-bench:result") renderer = r;
		},
	};
	// biome-ignore lint/suspicious/noExplicitAny: a minimal fake of the ExtensionAPI surface used here.
	benchExtension(pi as any);
	if (!renderer) throw new Error("result renderer was not registered");
	return renderer;
}

/** A theme whose `fg`/`bg` pass the text straight through, so rendered lines are readable. */
const theme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s };

function render(data: unknown, expanded: boolean): string {
	return resultRenderer()({ data } as { data: unknown }, { expanded }, theme)
		.render(80)
		.join("\n");
}

const runData = {
	kind: "run" as const,
	runId: "2026-run-x",
	markdown: "# judge-bench run\n\n| metric | value |\n| --- | --- |\n| let-through | 20.0% |",
	reading: null,
	readingNote: null,
	timestamp: 0,
};

describe("pi-guru-bench:result renderer", () => {
	it("collapsed: shows the namespace tag, kind, and run id only", () => {
		const out = render(runData, false);
		expect(out).toContain("[pi-guru-bench]");
		expect(out).toContain("run result");
		expect(out).toContain("2026-run-x");
		expect(out).not.toContain("let-through"); // the table is only in the expanded body
	});

	it("expanded: renders the report table", () => {
		const out = render(runData, true);
		expect(out).toContain("let-through");
	});

	it("expanded: renders a generated reading under its label", () => {
		const out = render(
			{ ...runData, reading: { markdown: "The let-through rate is 20% with a wide interval." } },
			true,
		);
		expect(out).toContain("generated");
		expect(out).toContain("wide interval");
	});

	it("expanded: shows the one-line note when the reading was suppressed", () => {
		const out = render(
			{ ...runData, readingNote: "Plain-language reading suppressed: a source has only 3 records (< 20)." },
			true,
		);
		expect(out).toContain("suppressed");
	});

	it("does not throw when the entry has no data", () => {
		expect(() => render(undefined, true)).not.toThrow();
	});
});
