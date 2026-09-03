/**
 * Hard denies: deterministic rules that block a change call before the gate, that no
 * judge mode or session allow can override (CONTEXT.md).
 *
 * The seed list is borrowed from czottmann/pi-automode (MIT) — recursive deletes of
 * root/home, shell-profile and authorized_keys writes, crontab edits, TLS-verification
 * disabling, and `chmod 777` on root/home. To it we add pi-guru's own config file.
 *
 * Each rule is tagged with a `kind` that decides what text it is matched against:
 *   - `command` — the raw bash command (rm, curl, chmod, crontab, TLS env vars).
 *   - `path`    — a *resolved* path: a bash redirection target or a write/edit target path
 *                 (shell startup files, `~/.ssh/authorized_keys`, pi-guru's config). Matching
 *                 resolved paths, not raw command text, defeats shell quote-obfuscation and
 *                 kills the `pi-guru.json` substring false positive.
 *   - `config`  — a user-supplied regex; matched against the raw command *and* the target path,
 *                 preserving how config rules worked before the split.
 */

import { extractArgTargets, extractRedirectTargets } from "./classify.ts";

/** What text a rule is matched against. */
export type RuleKind = "command" | "path" | "config";

export interface HardDenyRule {
	/** Regex source string, so config rules can be merged in as plain strings. */
	source: string;
	flags: string;
	reason: string;
	/** What text to match against; defaults to `command` (match the raw command text). */
	kind?: RuleKind;
}

/** A compiled rule: its RegExp, the reason to report, and what to match it against. */
export interface CompiledRule {
	re: RegExp;
	reason: string;
	kind: RuleKind;
}

/** Recursive/force `rm` whose target is `/`, `~`, `$HOME`, or the current directory root. */
const RM_ROOT_OR_HOME =
	"\\brm\\b(?=[^|;&\\n]*\\s(?:-\\w*[rf]\\w*|--recursive|--force))[^|;&\\n]*\\s(?:/(?:\\s|$|\\*)|~(?:/\\s*\\*?)?(?:\\s|$)|\\$HOME\\b|\\$\\{HOME\\}|\\./?(?:\\s|$)|\\*(?:\\s|$))";

/** The seed hard-deny list. Attribution: czottmann/pi-automode (MIT). */
export const SEED_RULES: HardDenyRule[] = [
	{
		source: RM_ROOT_OR_HOME,
		flags: "i",
		reason: "recursive delete of root, home, or the current directory",
		kind: "command",
	},
	{
		// Path-anchored: a full `.bashrc`/`.zshrc`/`.profile`/`.zprofile` segment, so it matches
		// a resolved redirection or write target (`~/.bashrc`) but not a prose mention.
		source: "(^|/)\\.(?:bashrc|zshrc|profile|zprofile)(?:$|/)",
		flags: "",
		reason: "write to a shell startup file",
		kind: "path",
	},
	{ source: "\\.ssh/authorized_keys", flags: "", reason: "write to ~/.ssh/authorized_keys", kind: "path" },
	{
		// A crontab that modifies: `crontab -e`, `crontab -r`, `crontab <file>`, bare `crontab`.
		// The negative lookahead lets a `crontab -l` (list = read) through, so a read is no longer
		// reported as an edit. `-u user` alongside `-l` is still a read.
		source: "\\bcrontab\\b(?![^|;&\\n]*\\s-l\\b)",
		flags: "",
		reason: "crontab modification",
		kind: "command",
	},
	{
		source: "\\bcurl\\b[^|;&\\n]*\\s(?:--insecure|-k)\\b",
		flags: "i",
		reason: "curl with TLS verification disabled",
		kind: "command",
	},
	{
		source: "\\bNODE_TLS_REJECT_UNAUTHORIZED\\s*=\\s*0",
		flags: "",
		reason: "TLS verification disabled (NODE_TLS_REJECT_UNAUTHORIZED=0)",
		kind: "command",
	},
	{
		source: "\\bGIT_SSL_NO_VERIFY\\b",
		flags: "",
		reason: "TLS verification disabled (GIT_SSL_NO_VERIFY)",
		kind: "command",
	},
	{
		source: "\\bchmod\\b[^|;&\\n]*\\s777\\b[^|;&\\n]*\\s(?:/(?:\\s|$)|~(?:/\\s*)?(?:\\s|$)|\\$HOME\\b)",
		flags: "i",
		reason: "chmod 777 on root or home",
		kind: "command",
	},
	{
		// Path-anchored only: the broad `\bpi-guru\.json\b` substring rule is gone —
		// it false-positived on any command that merely mentioned the file and killed the turn.
		source: "(^|/)\\.pi/(?:agent/)?pi-guru\\.json\\b",
		flags: "",
		reason: "write to pi-guru's own config file",
		kind: "path",
	},
];

/**
 * Longest subject we match a hard-deny rule against. Real commands and paths are far
 * shorter; a subject past this cap is truncated before matching so a pathological input
 * cannot drive backtracking work without bound. A truncation-induced miss
 * merely falls through to the normal gate, where a person still decides — fail-safe.
 */
const MAX_SUBJECT_LEN = 10_000;

/**
 * Reject the catastrophic-backtracking signature: an unbounded quantifier (`*`, `+`,
 * `{n,}`) applied to a group that itself contains an unbounded quantifier (star height
 * ≥ 2, e.g. `(a+)+`). A single left-to-right scan tracking group nesting — no full parse.
 * Configured hard-deny sources that trip this are dropped rather than run, so a project or
 * global config cannot ReDoS the gate. The vetted seed rules all pass.
 */
export function hasCatastrophicBacktracking(source: string): boolean {
	const unboundedAt = (i: number): boolean => {
		const c = source[i];
		if (c === "*" || c === "+") return true;
		if (c === "{") return /^\{\d*,\}/.test(source.slice(i)); // {n,} — no upper bound
		return false;
	};
	// One flag per open group: has it seen an unbounded quantifier at its own level?
	const groupHasUnbounded: boolean[] = [];
	let escaped = false;
	let inClass = false;
	for (let i = 0; i < source.length; i++) {
		const c = source[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (c === "\\") {
			escaped = true;
			continue;
		}
		if (inClass) {
			if (c === "]") inClass = false;
			continue;
		}
		if (c === "[") {
			inClass = true;
		} else if (c === "(") {
			groupHasUnbounded.push(false);
		} else if (c === ")") {
			const innerHadUnbounded = groupHasUnbounded.pop() ?? false;
			if (unboundedAt(i + 1)) {
				if (innerHadUnbounded) return true; // nested unbounded quantifiers → ReDoS
				if (groupHasUnbounded.length > 0) groupHasUnbounded[groupHasUnbounded.length - 1] = true;
			}
		} else if ((c === "*" || c === "+" || c === "{") && unboundedAt(i)) {
			if (groupHasUnbounded.length > 0) groupHasUnbounded[groupHasUnbounded.length - 1] = true;
		}
	}
	return false;
}

/**
 * Compile a rule list into RegExp objects, skipping any that fail to compile or that carry
 * the catastrophic-backtracking signature. Each compiled rule keeps its `kind`.
 */
export function compileRules(rules: HardDenyRule[]): CompiledRule[] {
	const compiled: CompiledRule[] = [];
	for (const rule of rules) {
		if (hasCatastrophicBacktracking(rule.source)) {
			// A ReDoS-prone config regex is dropped rather than allowed to hang the gate.
			continue;
		}
		try {
			compiled.push({
				re: new RegExp(rule.source, rule.flags),
				reason: rule.reason,
				kind: rule.kind ?? "command",
			});
		} catch {
			// A malformed config regex is ignored rather than crashing the gate.
		}
	}
	return compiled;
}

/** Cap a subject at `MAX_SUBJECT_LEN` so pathological input can't drive unbounded work. */
function cap(subject: string): string {
	return subject.length > MAX_SUBJECT_LEN ? subject.slice(0, MAX_SUBJECT_LEN) : subject;
}

/**
 * Test a text subject against **every** rule in a compiled list, ignoring kind. The first
 * matching rule's reason, or undefined. The generic primitive — the pipeline uses the
 * kind-aware `hardDenyBash` / `hardDenyPath` below; this stays for rule-level checks.
 */
export function hardDeny(subject: string, rules: CompiledRule[]): string | undefined {
	const capped = cap(subject);
	for (const { re, reason } of rules) {
		re.lastIndex = 0;
		if (re.test(capped)) return reason;
	}
	return undefined;
}

/**
 * Hard-deny a bash command. `command`/`config` rules match the raw
 * command text; `path` rules match each **resolved** write target — a redirection target
 * (`>`/`>>`/…) or a path argument to a known writing command (`sed -i`, `tee`, `cp`, `mv`, …;
 * the design notes) — so shell quote-obfuscation and argument-passed paths no longer evade them. Rules
 * are tried in seed order.
 */
export function hardDenyBash(command: string, rules: CompiledRule[]): string | undefined {
	const capped = cap(command);
	let targets: string[] | undefined; // parsed lazily, only if a path rule needs them
	for (const { re, reason, kind } of rules) {
		if (kind === "path") {
			if (targets === undefined) targets = [...extractRedirectTargets(capped), ...extractArgTargets(capped)];
			for (const target of targets) {
				re.lastIndex = 0;
				if (re.test(target)) return reason;
			}
		} else {
			re.lastIndex = 0;
			if (re.test(capped)) return reason;
		}
	}
	return undefined;
}

/**
 * Hard-deny a write/edit target path. `path`/`config` rules match the resolved
 * target path; `command` rules (shell-command shapes) do not apply to a path.
 */
export function hardDenyPath(path: string, rules: CompiledRule[]): string | undefined {
	const capped = cap(path);
	for (const { re, reason, kind } of rules) {
		if (kind === "command") continue;
		re.lastIndex = 0;
		if (re.test(capped)) return reason;
	}
	return undefined;
}

/** Build the compiled rule list: seed rules plus extra regex source strings from config. */
export function buildRules(extraSources: readonly string[] = []): CompiledRule[] {
	const extra: HardDenyRule[] = extraSources.map((source) => ({
		source,
		flags: "",
		reason: `blocked by a configured hard-deny rule`,
		kind: "config",
	}));
	return compileRules([...SEED_RULES, ...extra]);
}
