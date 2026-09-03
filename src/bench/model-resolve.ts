/**
 * Model resolution for the bench, ONLY through pi's model registry.
 *
 * The bench never reads provider config itself. A run resolves its model exactly one of three ways:
 * no spec → the session model (`ctx.model`); a `provider/model` string → an exact registry match;
 * otherwise a unique case-insensitive substring over the configured models' `provider/id`. Ambiguity
 * is an error that lists the candidates. A resolved model without configured auth is *skipped* with
 * the same guard production uses (`hasConfiguredAuth`), not silently run.
 *
 * Pure over a minimal `ModelLike[]` + auth predicate so it is tested with a fake registry, never a
 * real one. The extension adapts `ctx.modelRegistry` into these two inputs.
 */

/** The subset of a pi `Model` the bench identifies and reports a model by. */
export interface ModelLike {
	provider: string;
	id: string;
	reasoning?: boolean;
}

/** A resolved model, an error to show the person, or a skip because auth is missing. */
export type ResolveResult<M extends ModelLike = ModelLike> =
	| { kind: "ok"; model: M }
	| { kind: "error"; message: string }
	| { kind: "skip"; message: string };

/** `provider/id` — the canonical way the bench names a model in reports and filenames. */
export function modelLabel(model: ModelLike): string {
	return `${model.provider}/${model.id}`;
}

/**
 * Resolve the model for a run. `spec` is the optional `[provider/model]` argument; `sessionModel`
 * is `ctx.model`. `hasAuth` is the production auth guard. Order: no spec → session model; a spec with
 * a slash → exact `provider/id` (falling back to substring if no exact hit); otherwise substring.
 */
export function resolveModel<M extends ModelLike>(
	models: M[],
	hasAuth: (model: M) => boolean,
	spec: string | undefined,
	sessionModel: M | undefined,
): ResolveResult<M> {
	const trimmed = spec?.trim();
	if (!trimmed) {
		if (!sessionModel) {
			return {
				kind: "error",
				message: "no session model — pass a model as provider/model or a unique substring",
			};
		}
		return authGuard(sessionModel, hasAuth);
	}

	const matches = matchModels(models, trimmed);
	if (matches.length === 0) {
		return { kind: "error", message: `no configured model matches '${trimmed}'` };
	}
	if (matches.length > 1) {
		const candidates = matches.map(modelLabel).sort().join(", ");
		return { kind: "error", message: `'${trimmed}' is ambiguous — candidates: ${candidates}` };
	}
	return authGuard(matches[0], hasAuth);
}

/** Skip (not error) when the resolved model lacks configured auth — production's guard. */
function authGuard<M extends ModelLike>(model: M, hasAuth: (model: M) => boolean): ResolveResult<M> {
	if (!hasAuth(model)) {
		return { kind: "skip", message: `${modelLabel(model)} has no configured auth — skipped` };
	}
	return { kind: "ok", model };
}

/**
 * Match a spec to configured models. A spec with a slash is a `provider/model` id and must match
 * `provider/id` exactly; a spec without one is a case-insensitive substring over `provider/id`. The
 * two forms stay distinct so a mistyped `provider/model` errors clearly rather than fuzzy-matching.
 */
function matchModels<M extends ModelLike>(models: M[], spec: string): M[] {
	const needle = spec.toLowerCase();
	if (spec.includes("/")) {
		return models.filter((m) => modelLabel(m).toLowerCase() === needle);
	}
	return models.filter((m) => modelLabel(m).toLowerCase().includes(needle));
}
