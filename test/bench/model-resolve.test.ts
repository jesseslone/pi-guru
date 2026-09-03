import { describe, expect, it } from "vitest";
import { type ModelLike, modelLabel, resolveModel } from "../../src/bench/model-resolve.ts";

const MODELS: ModelLike[] = [
	{ provider: "anthropic", id: "claude-sonnet-5", reasoning: true },
	{ provider: "anthropic", id: "claude-opus-4-8", reasoning: true },
	{ provider: "openai", id: "gpt-5", reasoning: false },
];

/** All models authed unless the id is in `noAuth`. */
function auth(noAuth: string[] = []) {
	return (m: ModelLike) => !noAuth.includes(m.id);
}

describe("resolveModel", () => {
	it("uses the session model when no spec is given", () => {
		const session = MODELS[0];
		const r = resolveModel(MODELS, auth(), undefined, session);
		expect(r).toEqual({ kind: "ok", model: session });
	});

	it("errors when no spec and no session model", () => {
		const r = resolveModel(MODELS, auth(), undefined, undefined);
		expect(r.kind).toBe("error");
	});

	it("resolves an exact provider/model spec", () => {
		const r = resolveModel(MODELS, auth(), "openai/gpt-5", MODELS[0]);
		expect(r).toEqual({ kind: "ok", model: MODELS[2] });
	});

	it("resolves a unique substring", () => {
		const r = resolveModel(MODELS, auth(), "opus", undefined);
		expect(r.kind === "ok" && modelLabel(r.model)).toBe("anthropic/claude-opus-4-8");
	});

	it("errors with the candidate list on an ambiguous substring", () => {
		const r = resolveModel(MODELS, auth(), "claude", undefined);
		expect(r.kind).toBe("error");
		if (r.kind === "error") {
			expect(r.message).toContain("ambiguous");
			expect(r.message).toContain("anthropic/claude-opus-4-8");
			expect(r.message).toContain("anthropic/claude-sonnet-5");
		}
	});

	it("errors when nothing matches", () => {
		const r = resolveModel(MODELS, auth(), "llama", undefined);
		expect(r.kind).toBe("error");
	});

	it("skips (not errors) a resolved model without configured auth", () => {
		const r = resolveModel(MODELS, auth(["gpt-5"]), "openai/gpt-5", undefined);
		expect(r.kind).toBe("skip");
		if (r.kind === "skip") expect(r.message).toContain("no configured auth");
	});

	it("skips the session model too when it lacks auth", () => {
		const r = resolveModel(MODELS, auth(["claude-sonnet-5"]), undefined, MODELS[0]);
		expect(r.kind).toBe("skip");
	});

	it("errors on a mistyped provider/model spec rather than fuzzy-matching", () => {
		const r = resolveModel(MODELS, auth(), "anthropic/opus", undefined);
		expect(r.kind).toBe("error"); // no exact provider/id — a slash spec must be exact
	});

	it("matches a substring against the id alone", () => {
		const r = resolveModel(MODELS, auth(), "gpt", undefined);
		expect(r.kind === "ok" && r.model.id).toBe("gpt-5");
	});
});
