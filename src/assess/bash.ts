/**
 * Bash risk facts from the unbash AST.
 *
 * Two rules, borrowed from `docs/research/risk-assessors.md`: **literal words only** (OpenAI Codex's
 * shell-command crate — static spelling identifies dangerous commands but must never prove safety),
 * and **unresolved is a fact** (pi-permission-system's fail-closed wrappers — a command or process
 * substitution, or an unlisted wrapper, means coverage was partial and the judge is told so). Every
 * path fact runs on a **resolved** path (see `paths.ts`), never raw text, so quoting and `..` cannot
 * evade it. The existing `extractRedirectTargets` / `extractArgTargets` / `extractCommandWords`
 * helpers are reused so this stays consistent with the hard-deny path resolution.
 */

import type { AssignmentPrefix, Command, Node, Pipeline, Redirect } from "unbash";
import { parse } from "unbash";
import { extractArgTargets, extractCommandWords, extractRedirectTargets } from "../classify.ts";
import { binaryEntry } from "./binaries.ts";
import { isCredentialPath, isInsideProject, isSystemPath, resolvePath } from "./paths.ts";
import type { AssessContext, Fact } from "./types.ts";

/** Network-fetch binaries whose output piped into a shell is `network-to-shell`. */
const FETCHERS = new Set(["curl", "wget", "fetch"]);

/** Shell / interpreter sinks a fetch or a base64 decode can be piped into. */
const SHELL_SINKS = new Set([
	"sh",
	"bash",
	"dash",
	"zsh",
	"ksh",
	"python",
	"python3",
	"python2",
	"perl",
	"ruby",
	"php",
	"node",
	"sudo",
]);

/** Privilege-escalation command names. */
const SUDO_NAMES = new Set(["sudo", "doas", "su"]);

/** Commands whose every non-option operand is a path they read. */
const READERS = new Set([
	"cat",
	"less",
	"more",
	"head",
	"tail",
	"strings",
	"xxd",
	"od",
	"hexdump",
	"nl",
	"tac",
	"base64",
	"gpg",
	"grep",
	"egrep",
	"fgrep",
	"awk",
	"cut",
	"sort",
	"wc",
	"md5sum",
	"sha1sum",
	"sha256sum",
	"openssl",
]);

/** Commands whose leading operands are read *sources* and only the last is the destination. */
const COPIERS = new Set(["cp", "install", "ln", "scp", "rsync"]);

/** String wrappers whose `-c` operand is a dynamically constructed command (`eval`-class). */
const STRING_C_SHELLS = new Set(["sh", "bash", "dash", "zsh", "ksh"]);

/** Package managers whose install of a URL (or with an unsafe flag) is `package-install-from-url`. */
const PKG_MANAGERS: Record<string, Set<string>> = {
	npm: new Set(["install", "i", "add"]),
	pnpm: new Set(["install", "i", "add"]),
	yarn: new Set(["add", "install"]),
	pip: new Set(["install"]),
	pip3: new Set(["install"]),
	gem: new Set(["install"]),
	cargo: new Set(["install"]),
	go: new Set(["install", "get"]),
	apt: new Set(["install"]),
	"apt-get": new Set(["install"]),
	brew: new Set(["install"]),
};

/** Literal flags / tokens that disable TLS or signature verification. */
const TLS_DISABLING_TOKENS = [
	"--no-check-certificate",
	"--trusted-host",
	"--allow-unauthenticated",
	"http.sslVerify=false",
	"sslVerify=false",
	"strict-ssl=false",
	"--strict-ssl=false",
	"--no-verify-ssl",
];

/** Env assignments that disable TLS verification (name → the value that disables). */
const TLS_DISABLING_ENV: Record<string, string> = {
	NODE_TLS_REJECT_UNAUTHORIZED: "0",
	PYTHONHTTPSVERIFY: "0",
};

/** Env names whose mere presence disables verification, whatever the value. */
const TLS_DISABLING_ENV_PRESENCE = new Set(["GIT_SSL_NO_VERIFY"]);

/** Feature-branch ref prefixes: a force-push naming one of these is not flagged. */
const FEATURE_PREFIXES = ["feature/", "feat/", "fix/", "bugfix/", "hotfix/", "chore/", "wip/", "dev/"];

/** Curl flags that reference a local file to upload / send as the request body. */
const CURL_UPLOAD_FLAGS = new Set(["-T", "--upload-file"]);
const CURL_DATA_FLAGS = new Set([
	"-d",
	"--data",
	"--data-binary",
	"--data-ascii",
	"--data-raw",
	"-F",
	"--form",
]);

/** The bash assessment: the facts found and whether the command resolved to literal words. */
export interface BashAssessment {
	facts: Fact[];
	unresolved: boolean;
}

/** Assess a raw bash command: parse once, collect commands and pipelines, run every fact rule. */
export function assessBash(command: string, ctx: AssessContext): BashAssessment {
	const facts: Fact[] = [];
	const script = parse(command);
	if (script.errors && script.errors.length > 0) {
		// Unparseable: no literal words to reason over. One `unresolved` fact and nothing else.
		return { facts: [factUnresolved("the command could not be parsed")], unresolved: true };
	}

	const unresolved = !extractCommandWords(command).resolved;
	if (unresolved)
		facts.push(factUnresolved("a substitution or an unlisted wrapper hides part of the command"));

	const commands: Command[] = [];
	const pipelines: Pipeline[] = [];
	walk(script.commands, commands, pipelines);

	for (const cmd of commands) collectCommandFacts(cmd, ctx, facts);
	for (const pipe of pipelines) collectPipelineFacts(pipe, facts);

	// Write-target facts reuse the hard-deny path extraction so the resolved targets match the design notes/#9.
	collectWriteTargetFacts(command, ctx, facts);

	return { facts: dedupe(facts), unresolved };
}

/** The `unresolved` info fact. */
function factUnresolved(evidence: string): Fact {
	return { id: "unresolved", text: "pi-guru could not fully parse this command", severity: "info", evidence };
}

// --- AST walk -------------------------------------------------------------

/** Collect every simple `Command` and every `Pipeline` node reachable from a list of nodes. */
function walk(nodes: Node[], commands: Command[], pipelines: Pipeline[]): void {
	for (const node of nodes) walkNode(node, commands, pipelines);
}

function walkNode(node: Node, commands: Command[], pipelines: Pipeline[]): void {
	switch (node.type) {
		case "Command":
			commands.push(node);
			return;
		case "Pipeline":
			pipelines.push(node);
			walk(node.commands, commands, pipelines);
			return;
		case "AndOr":
			walk(node.commands, commands, pipelines);
			return;
		case "Statement":
			walkNode(node.command, commands, pipelines);
			return;
		case "Subshell":
		case "BraceGroup":
			walk(node.body.commands, commands, pipelines);
			return;
		case "CompoundList":
			walk(node.commands, commands, pipelines);
			return;
		case "If":
			walkNode(node.clause, commands, pipelines);
			walkNode(node.then, commands, pipelines);
			if (node.else) walkNode(node.else, commands, pipelines);
			return;
		case "For":
		case "Select":
		case "While":
			walkNode(node.body, commands, pipelines);
			if ("clause" in node && node.clause) walkNode(node.clause, commands, pipelines);
			return;
		case "Case":
			for (const item of node.items) walkNode(item.body, commands, pipelines);
			return;
		case "Function":
			walkNode(node.body, commands, pipelines);
			return;
		default:
			return;
	}
}

/** The lead simple-command name of a pipeline stage (descending statements/pipelines/and-ors). */
function leadName(node: Node): string | undefined {
	switch (node.type) {
		case "Command":
			return node.name?.value;
		case "Statement":
			return leadName(node.command);
		case "Pipeline":
		case "AndOr":
			return node.commands[0] ? leadName(node.commands[0]) : undefined;
		case "Subshell":
		case "BraceGroup":
			return node.body.commands[0] ? leadName(node.body.commands[0]) : undefined;
		default:
			return undefined;
	}
}

/** The lead command node of a pipeline stage — for reading its flags (e.g. base64 -d). */
function leadCommand(node: Node): Command | undefined {
	switch (node.type) {
		case "Command":
			return node;
		case "Statement":
			return leadCommand(node.command);
		case "Pipeline":
		case "AndOr":
			return node.commands[0] ? leadCommand(node.commands[0]) : undefined;
		case "Subshell":
		case "BraceGroup":
			return node.body.commands[0] ? leadCommand(node.body.commands[0]) : undefined;
		default:
			return undefined;
	}
}

// --- wrapper unwrapping ---------------------------------------------------

/** Prefix wrappers whose real command follows, with the options that consume a following argument. */
const UNWRAP_ARG_OPTS: Record<string, Set<string>> = {
	sudo: new Set([
		"-u",
		"--user",
		"-g",
		"--group",
		"-p",
		"--prompt",
		"-C",
		"-r",
		"--role",
		"-t",
		"--type",
		"-U",
	]),
	doas: new Set(["-u", "-C"]),
	env: new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]),
	nohup: new Set(),
	time: new Set(["-o", "--output", "-f", "--format"]),
};

/** The real command behind any leading sudo/doas/env/nohup/time wrappers, plus the wrapper names seen. */
function unwrap(
	name: string,
	args: string[],
): { name: string | undefined; args: string[]; wrappers: string[] } {
	const wrappers: string[] = [];
	let n: string | undefined = name;
	let a = args;
	while (n !== undefined && n in UNWRAP_ARG_OPTS) {
		wrappers.push(n);
		const opts = UNWRAP_ARG_OPTS[n];
		const allowAssign = n === "env";
		let i = 0;
		while (i < a.length) {
			const w = a[i];
			if (w === "--") {
				i++;
				break;
			}
			if (w.startsWith("-")) {
				i += opts.has(w) ? 2 : 1;
				continue;
			}
			if (allowAssign && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
				i++;
				continue;
			}
			break;
		}
		if (i >= a.length) return { name: undefined, args: [], wrappers };
		n = a[i];
		a = a.slice(i + 1);
	}
	return { name: n, args: a, wrappers };
}

// --- per-command facts ----------------------------------------------------

function collectCommandFacts(cmd: Command, ctx: AssessContext, facts: Fact[]): void {
	const rawName = cmd.name?.value;
	if (rawName === undefined) return;
	const rawArgs = cmd.suffix.map((w) => w.value);
	// Unwrap leading sudo/doas/env/nohup/time so the fact rules see the real command behind them; the
	// TLS scan still reads the *outer* args so an `env NODE_TLS_REJECT_UNAUTHORIZED=0 …` prefix is caught.
	const { name, args, wrappers } = unwrap(rawName, rawArgs);
	const sudoName = wrappers.find((w) => SUDO_NAMES.has(w)) ?? (SUDO_NAMES.has(rawName) ? rawName : undefined);
	if (sudoName) {
		facts.push({
			id: "sudo",
			text: "runs with elevated privileges (sudo/doas/su)",
			severity: "medium",
			evidence: sudoName,
		});
	}
	collectTlsFacts(cmd.prefix, name ?? rawName, rawArgs, facts);
	if (name === undefined) return; // a wrapper with no inner command (e.g. bare `env`)

	collectCredentialReadFacts(name, args, cmd.redirects, ctx, facts);
	collectNetworkSendFacts(name, args, cmd.redirects, facts);
	collectEvalFacts(name, args, facts);
	collectDeleteFacts(name, args, ctx, facts);
	collectPackageInstallFacts(name, args, facts);
	collectGitFacts(name, args, facts);
	collectChmodFacts(name, args, facts);
	collectBinaryFacts(name, args, cmd.redirects, facts);
}

/** `reads-credential-file`: a reader/copier operand, or an input redirect, resolving to a credential. */
function collectCredentialReadFacts(
	name: string,
	args: string[],
	redirects: Redirect[],
	ctx: AssessContext,
	facts: Fact[],
): void {
	const sources: string[] = [];
	if (READERS.has(name)) sources.push(...operands(args));
	else if (COPIERS.has(name)) sources.push(...sourcesOfCopier(args));
	else if (name === "dd") {
		for (const a of args) if (a.startsWith("if=")) sources.push(a.slice(3));
	}
	// Input redirects (`<`, `<<<`) read a file into any command.
	for (const r of redirects) {
		if ((r.operator === "<" || r.operator === "<<<") && r.target?.value) sources.push(r.target.value);
	}
	for (const src of sources) {
		const abs = resolvePath(src, ctx);
		if (abs && isCredentialPath(abs, ctx.home)) {
			facts.push({
				id: "reads-credential-file",
				text: "reads or copies a credential, key, or secret file",
				severity: "high",
				evidence: abs,
			});
		}
	}
}

/** `network-send-local-data`: curl uploading a file, nc/ncat piping a file, scp/rsync to a remote. */
function collectNetworkSendFacts(name: string, args: string[], redirects: Redirect[], facts: Fact[]): void {
	if (name === "curl") {
		const flag = curlUploadsFile(args);
		if (flag) {
			facts.push({
				id: "network-send-local-data",
				text: "sends local file data to a remote host",
				severity: "high",
				evidence: `curl ${flag}`,
			});
		}
	}
	if (
		(name === "nc" || name === "ncat") &&
		redirects.some((r) => r.operator === "<" || r.operator === "<<<")
	) {
		facts.push({
			id: "network-send-local-data",
			text: "sends local file data to a remote host",
			severity: "high",
			evidence: `${name} < file`,
		});
	}
	if ((name === "scp" || name === "rsync") && lastOperandIsRemote(args)) {
		facts.push({
			id: "network-send-local-data",
			text: "sends local file data to a remote host",
			severity: "high",
			evidence: `${name} to a remote destination`,
		});
	}
}

/** `eval-dynamic-exec`: an `eval` command, or `bash -c` / `sh -c` (a constructed command string). */
function collectEvalFacts(name: string, args: string[], facts: Fact[]): void {
	if (name === "eval") {
		facts.push({
			id: "eval-dynamic-exec",
			text: "runs a dynamically constructed command (eval / shell -c / decoded input)",
			severity: "medium",
			evidence: "eval",
		});
		return;
	}
	if (STRING_C_SHELLS.has(name) && args.includes("-c")) {
		facts.push({
			id: "eval-dynamic-exec",
			text: "runs a dynamically constructed command (eval / shell -c / decoded input)",
			severity: "medium",
			evidence: `${name} -c`,
		});
	}
}

/** `recursive-delete-outside-cwd`: `rm -r` whose resolved target is outside the project. */
function collectDeleteFacts(name: string, args: string[], ctx: AssessContext, facts: Fact[]): void {
	if (name !== "rm") return;
	if (!hasRecursiveFlag(args)) return;
	for (const op of operands(args)) {
		const abs = resolvePath(op, ctx);
		if (abs && !isInsideProject(abs, ctx.cwd)) {
			facts.push({
				id: "recursive-delete-outside-cwd",
				text: "recursively deletes a path outside the project directory",
				severity: "medium",
				evidence: abs,
			});
		}
	}
}

/** `package-install-from-url`: a package-manager install of a URL, or with --unsafe-perm/--allow-root. */
function collectPackageInstallFacts(name: string, args: string[], facts: Fact[]): void {
	const verbs = PKG_MANAGERS[name];
	if (!verbs) return;
	const sub = operands(args)[0];
	if (!sub || !verbs.has(sub)) return;
	const url = args.find((a) => /^(?:https?|git\+https?|git):\/\//i.test(a));
	const unsafe = args.find((a) => a === "--unsafe-perm" || a === "--allow-root");
	if (url || unsafe) {
		facts.push({
			id: "package-install-from-url",
			text: "installs a package from a URL or with elevated install flags",
			severity: "medium",
			evidence: url ?? (unsafe as string),
		});
	}
}

/** `disables-verification`: an env assignment or a flag that turns off TLS / signature checking. */
function collectTlsFacts(prefix: AssignmentPrefix[], name: string, args: string[], facts: Fact[]): void {
	const add = (evidence: string) =>
		facts.push({
			id: "disables-verification",
			text: "disables TLS or signature verification",
			severity: "high",
			evidence,
		});
	for (const p of prefix) {
		if (!p.name) continue;
		if (p.name in TLS_DISABLING_ENV && p.value?.value === TLS_DISABLING_ENV[p.name])
			add(`${p.name}=${p.value.value}`);
		if (TLS_DISABLING_ENV_PRESENCE.has(p.name)) add(p.name);
	}
	for (const a of args) {
		if (TLS_DISABLING_TOKENS.some((tok) => a === tok || a.startsWith(`${tok}=`) || a.includes(tok))) add(a);
		// curl -k / --insecure (also hard-denied, but the fact is still true for the judge's context).
		if (name === "curl" && (a === "-k" || a === "--insecure")) add(a);
		// A leading env token as an operand (`env NODE_TLS_REJECT_UNAUTHORIZED=0 …`, `export …`).
		const eq = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(a);
		if (eq) {
			const [, k, v] = eq;
			if (k in TLS_DISABLING_ENV && v === TLS_DISABLING_ENV[k]) add(a);
			if (TLS_DISABLING_ENV_PRESENCE.has(k)) add(a);
		}
	}
}

/** `git-force-push` and `git-destructive` (clean -f / reset --hard). */
function collectGitFacts(name: string, args: string[], facts: Fact[]): void {
	if (name !== "git") return;
	const ops = operands(args);
	const sub = ops[0];
	if (sub === "push" && args.some((a) => a === "--force" || a === "-f" || a === "--force-with-lease")) {
		const feature = ops.some((op) => FEATURE_PREFIXES.some((pre) => op.startsWith(pre)));
		if (!feature) {
			facts.push({
				id: "git-force-push",
				text: "force-pushes to a branch that is not a feature branch",
				severity: "medium",
				evidence: "git push --force",
			});
		}
	}
	if (sub === "clean" && args.some((a) => /^-\w*f/.test(a))) {
		facts.push({
			id: "git-destructive",
			text: "deletes untracked files with git clean -f",
			severity: "medium",
			evidence: "git clean -f",
		});
	}
	if (sub === "reset" && args.includes("--hard")) {
		facts.push({
			id: "git-destructive",
			text: "discards local changes with git reset --hard",
			severity: "medium",
			evidence: "git reset --hard",
		});
	}
}

/** `chmod-insecure`: a recursive chmod/chown, or a `777` mode. */
function collectChmodFacts(name: string, args: string[], facts: Fact[]): void {
	if (name !== "chmod" && name !== "chown") return;
	const recursive = args.some((a) => a === "-R" || a === "--recursive" || /^-\w*R/.test(a));
	const worldWritable = name === "chmod" && operands(args).some((a) => /^0?777$/.test(a));
	if (recursive || worldWritable) {
		facts.push({
			id: "chmod-insecure",
			text: worldWritable
				? "makes a path world-writable (chmod 777)"
				: `changes permissions recursively (${name} -R)`,
			severity: "medium",
			evidence: worldWritable ? "777" : `${name} -R`,
		});
	}
}

/** `binary-capability`: a curated binary exercised with a qualifying host/file/inline-code argument. */
function collectBinaryFacts(name: string, args: string[], redirects: Redirect[], facts: Fact[]): void {
	const entry = binaryEntry(name);
	if (!entry) return;
	const caps = entry.capabilities;
	const qualifies =
		(caps.includes("network") && hasNetworkArg(name, args)) ||
		(caps.includes("file") && hasFileArg(name, args, redirects)) ||
		(caps.includes("shell") && hasInlineCodeArg(name, args));
	if (qualifies) {
		facts.push({
			id: "binary-capability",
			text: `${name} ${entry.phrase}`,
			severity: "info",
			evidence: name,
		});
	}
}

// --- pipeline facts -------------------------------------------------------

function collectPipelineFacts(pipe: Pipeline, facts: Fact[]): void {
	const stages = pipe.commands.map((n) => leadName(n));
	// network-to-shell: a fetcher at some stage, a shell sink at a later stage.
	for (let i = 0; i < stages.length; i++) {
		if (!(stages[i] && FETCHERS.has(stages[i] as string))) continue;
		for (let j = i + 1; j < stages.length; j++) {
			if (stages[j] && SHELL_SINKS.has(stages[j] as string)) {
				facts.push({
					id: "network-to-shell",
					text: "pipes a network download into a shell interpreter",
					severity: "high",
					evidence: `${stages[i]} | … | ${stages[j]}`,
				});
			}
		}
	}
	// base64 -d | shell → dynamic execution of decoded input.
	for (let i = 0; i < pipe.commands.length; i++) {
		const cmd = leadCommand(pipe.commands[i]);
		if (cmd?.name?.value !== "base64") continue;
		const decodes = cmd.suffix.some((w) => w.value === "-d" || w.value === "-D" || w.value === "--decode");
		if (!decodes) continue;
		for (let j = i + 1; j < pipe.commands.length; j++) {
			if (stages[j] && SHELL_SINKS.has(stages[j] as string)) {
				facts.push({
					id: "eval-dynamic-exec",
					text: "runs a dynamically constructed command (eval / shell -c / decoded input)",
					severity: "medium",
					evidence: `base64 -d | ${stages[j]}`,
				});
			}
		}
	}
}

// --- write-target facts ---------------------------------------------------

/** `writes-system-path`: any resolved write target (redirection or write-arg) under a system path. */
function collectWriteTargetFacts(command: string, ctx: AssessContext, facts: Fact[]): void {
	const targets = [...extractRedirectTargets(command), ...extractArgTargets(command)];
	for (const t of targets) {
		const abs = resolvePath(t, ctx);
		if (abs && isSystemPath(abs, ctx.home)) {
			facts.push({
				id: "writes-system-path",
				text: "writes under a system path",
				severity: "medium",
				evidence: abs,
			});
		}
	}
}

// --- small helpers --------------------------------------------------------

/** Non-option operands: words not starting with `-`, plus everything after a `--` end-of-options. */
function operands(args: string[]): string[] {
	const out: string[] = [];
	let afterDoubleDash = false;
	for (const a of args) {
		if (afterDoubleDash) out.push(a);
		else if (a === "--") afterDoubleDash = true;
		else if (!a.startsWith("-")) out.push(a);
	}
	return out;
}

/** Source operands of a copier: every operand except the last (the destination). */
function sourcesOfCopier(args: string[]): string[] {
	const ops = operands(args);
	return ops.slice(0, Math.max(0, ops.length - 1));
}

/** True when an `rm` arg list carries a recursive flag (`-r`, `-R`, `--recursive`, `-rf`, `-fr`, …). */
function hasRecursiveFlag(args: string[]): boolean {
	return args.some((a) => a === "--recursive" || (/^-[a-zA-Z]*[rR]/.test(a) && !a.startsWith("--")));
}

/** The curl upload/data flag referencing a local file (`@file`, `-T file`), or undefined. */
function curlUploadsFile(args: string[]): string | undefined {
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (CURL_UPLOAD_FLAGS.has(a)) return a;
		if (a.startsWith("--upload-file=")) return "--upload-file";
		if (CURL_DATA_FLAGS.has(a)) {
			const val = args[i + 1] ?? "";
			if (val.startsWith("@")) return a;
		}
		// `--data@file` / `-d@file` inline, or `--data=@file`.
		const inline = /^(--data(?:-binary|-ascii|-raw)?|--form|-F|-d)=?@/.exec(a);
		if (inline) return inline[1];
	}
	return undefined;
}

/** True when the last operand of an scp/rsync command is a remote spec (`[user@]host:path`). */
function lastOperandIsRemote(args: string[]): boolean {
	const ops = operands(args);
	const dest = ops[ops.length - 1];
	return dest !== undefined && isRemoteSpec(dest);
}

/** A `[user@]host:path` remote spec — a colon after a host, not a URL scheme and no earlier slash. */
function isRemoteSpec(token: string): boolean {
	const colon = token.indexOf(":");
	if (colon <= 0) return false;
	const before = token.slice(0, colon);
	if (before.includes("/")) return false; // a local path like ./a:b or /a:b
	if (token.slice(colon).startsWith("://")) return false; // a URL
	return /^(?:[\w.-]+@)?[\w.-]+$/.test(before);
}

/** A network-capable binary's qualifying argument: a URL, a remote spec, or a host for nc/socat. */
function hasNetworkArg(name: string, args: string[]): boolean {
	if (args.some((a) => /^[a-z][a-z0-9+.-]*:\/\//i.test(a))) return true;
	if (args.some((a) => isRemoteSpec(a))) return true;
	if (name === "nc" || name === "ncat" || name === "socat") return operands(args).length > 0;
	return false;
}

/** A file-capable binary's qualifying argument: an `if=`/`of=` for dd, else a path-like operand. */
function hasFileArg(name: string, args: string[], redirects: Redirect[]): boolean {
	if (name === "dd") return args.some((a) => a.startsWith("if=") || a.startsWith("of="));
	if (redirects.some((r) => r.target?.value)) return true;
	return operands(args).some((a) => a.includes("/") || /\.[A-Za-z0-9]+$/.test(a));
}

/** A shell-capable binary's inline-code argument (`-c` / `-e`, or an nc/socat exec flag). */
function hasInlineCodeArg(name: string, args: string[]): boolean {
	if (name === "socat") return args.some((a) => /EXEC:|SYSTEM:/.test(a));
	if (name === "nc" || name === "ncat") return args.some((a) => a === "-e" || a === "--exec" || a === "-c");
	return args.some((a) => a === "-c" || a === "-e");
}

/** Drop facts with an identical id+evidence pair (a repeated binary or a doubled path). */
function dedupe(facts: Fact[]): Fact[] {
	const seen = new Set<string>();
	const out: Fact[] = [];
	for (const f of facts) {
		const key = `${f.id} ${f.evidence}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(f);
	}
	return out;
}
