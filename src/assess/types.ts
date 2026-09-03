/**
 * Types for the deterministic risk assessor.
 *
 * The assessor runs a static pass over a pending change call and emits neutral, verified **facts**
 * — never a decision. Because pi-guru computes them from the parsed command or the resolved path,
 * they are placed OUTSIDE the untrusted fence in the judge prompt ("Facts pi-guru verified"). A
 * small subset raise a deterministic **floor** applied after the model verdict (`max(verdict,
 * floor)`), so a class the model under-rates (reading credentials, piping the network into a shell)
 * still reaches the gate. See `docs/research/risk-assessors.md` for the design and the source list
 * (OpenAI Codex's "literal words only, never prove safety" rule; gitleaks MIT rules for secrets;
 * hand-curated binary capabilities because GTFOBins is GPL-3.0).
 */

/** A fact's own severity — how the assessor rates the signal in isolation. */
export type Severity = "info" | "medium" | "high";

/** The deterministic risk floor a fact can impose after the model verdict (a subset of severities). */
export type Floor = "medium" | "high";

/**
 * One verified fact about a pending call. `id` is a stable kebab-case slug (for floor mapping and
 * tests), `text` is the neutral one-line statement shown to the judge, `severity` is the fact's own
 * rating, and `evidence` is the concrete literal that triggered it (a resolved path, a command word,
 * a matched secret label) — never arbitrary free text, so the fact stays precise.
 */
export interface Fact {
	id: string;
	text: string;
	severity: Severity;
	evidence: string;
}

/** The assessor's output for one call: the facts, the highest floor any of them imposes, and coverage. */
export interface AssessResult {
	facts: Fact[];
	/** The strongest floor imposed by any fact, or undefined when no fact floors. */
	floor?: Floor;
	/**
	 * True when the command could not be fully parsed to literal words (a parse error, a command or
	 * process substitution, or an unlisted wrapper). The facts are then a partial view, and the
	 * judge is told coverage was incomplete. Always false for write/edit (paths/content are literal).
	 */
	unresolved: boolean;
}

/** The resolution context: the working directory and the home directory, for path resolution. */
export interface AssessContext {
	cwd: string;
	home: string;
}
