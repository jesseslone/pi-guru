/**
 * Path resolution and the credential / system-path predicates the assessor matches against
 *. Every predicate runs on a **resolved absolute path**, never raw command text, so
 * shell quoting and `..` cannot slip a target past a rule and a substring like `passwd.example`
 * never trips the `/etc/passwd` rule. Falco's sensitive-file lists and the issue's enumeration are
 * the seed (see `docs/research/risk-assessors.md`).
 */

import { basename, isAbsolute, posix, resolve } from "node:path";
import type { AssessContext } from "./types.ts";

/**
 * Resolve a raw path token to an absolute path: expand a leading `~` / `$HOME` / `${HOME}` to the
 * home dir, then resolve relative tokens against the cwd, normalising `..`. Returns undefined for a
 * token that is plainly not a path (empty, or a glob/brace we would only guess at).
 */
export function resolvePath(raw: string, ctx: AssessContext): string | undefined {
	if (raw === "") return undefined;
	// Expand a leading `~`, `$HOME`, or `${HOME}` (each only as a whole first segment) to the home dir.
	// Regexes, not string literals, so the `${HOME}` form carries no template-placeholder confusion.
	const p = raw
		.replace(/^~(?=\/|$)/, ctx.home)
		.replace(/^\$HOME(?=\/|$)/, ctx.home)
		.replace(/^\$\{HOME\}(?=\/|$)/, ctx.home);
	// resolve() normalises `..`/`.` and joins a relative token onto cwd; an absolute token stands.
	return isAbsolute(p) ? posix.normalize(p) : resolve(ctx.cwd, p);
}

/** True when `child` is `parent` or a path beneath it (segment-anchored, so `/etc` ≠ `/etcx`). */
export function isWithin(child: string, parent: string): boolean {
	const p = parent.replace(/\/+$/, "");
	return child === p || child.startsWith(`${p}/`);
}

/** Private-key basenames flagged wherever they appear (Falco's key list). */
const PRIVATE_KEY_NAMES = new Set(["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "identity"]);

/** Shell / REPL history basenames — reading them is recon, not a change. */
const HISTORY_NAMES = new Set([
	".bash_history",
	".zsh_history",
	".sh_history",
	".python_history",
	".node_repl_history",
	".psql_history",
	".mysql_history",
	".irb_history",
]);

/** Browser-profile directory signatures (credential/cookie stores live under these). */
const BROWSER_PROFILE_SIGNATURES = [
	"/Library/Application Support/Google/Chrome",
	"/Library/Application Support/Firefox",
	"/Library/Application Support/BraveSoftware",
	"/.config/google-chrome",
	"/.config/chromium",
	"/.config/BraveSoftware",
	"/.mozilla/firefox",
];

/** Env-file basenames that hold secrets, excluding the committed template variants. */
function isEnvSecret(base: string): boolean {
	if (!(base === ".env" || base.startsWith(".env."))) return false;
	return !(
		base.endsWith(".example") ||
		base.endsWith(".sample") ||
		base.endsWith(".template") ||
		base.endsWith(".dist")
	);
}

/**
 * True when a resolved path is a credential, key, or secret store: `~/.ssh/*`, a private-key
 * basename anywhere, `~/.aws/credentials`, `/etc/shadow`, `/etc/passwd`, `*.pem`, `.env[.local]`,
 * a shell/REPL history file, or a browser profile dir. Exact where it must be (`/etc/passwd`, not
 * `passwd.example`) and segment-anchored elsewhere.
 */
export function isCredentialPath(abs: string, home: string): boolean {
	const base = basename(abs);
	if (isWithin(abs, `${home}/.ssh`)) return true;
	if (PRIVATE_KEY_NAMES.has(base)) return true;
	if (abs === `${home}/.aws/credentials`) return true;
	if (abs === "/etc/shadow" || abs === "/etc/passwd") return true;
	if (base.endsWith(".pem")) return true;
	if (isEnvSecret(base)) return true;
	if (HISTORY_NAMES.has(base)) return true;
	if (BROWSER_PROFILE_SIGNATURES.some((sig) => abs.includes(sig))) return true;
	return false;
}

/** System path roots writes are floored under. */
const SYSTEM_ROOTS = ["/etc", "/usr", "/bin", "/sbin", "/boot", "/Library", "/System"];

/**
 * Explicit launchd / systemd unit dirs and crontab spools that fall outside the roots above (a
 * user's `~/Library/LaunchAgents`, `~/.config/systemd`, `/lib/systemd`, the cron spool). The roots
 * already cover `/etc/systemd`, `/etc/crontab`, `/etc/cron.*`, `/usr/lib/systemd`, and the
 * system-wide `/Library/Launch*`.
 */
function extraSystemDirs(home: string): string[] {
	return [
		`${home}/Library/LaunchAgents`,
		`${home}/.config/systemd`,
		"/lib/systemd",
		"/run/systemd",
		"/var/spool/cron",
	];
}

/**
 * True when a resolved path is under a system location or a launchd/systemd unit dir or the cron
 * spool — the write targets the issue floors at medium.
 */
export function isSystemPath(abs: string, home: string): boolean {
	if (SYSTEM_ROOTS.some((root) => isWithin(abs, root))) return true;
	if (extraSystemDirs(home).some((dir) => isWithin(abs, dir))) return true;
	return false;
}

/** True when a resolved path is the cwd itself or strictly beneath it (a project-local target). */
export function isInsideProject(abs: string, cwd: string): boolean {
	return isWithin(abs, cwd);
}
