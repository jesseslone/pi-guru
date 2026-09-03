/**
 * Read call vs change call classification, and bash command-word extraction.
 *
 * A read call only inspects (read, grep, find, ls, and configured read-only tools);
 * it is never gated. Everything else is a change call and is gated. See CONTEXT.md.
 *
 * Bash command-word extraction unwraps shell wrappers (`bash -c`, `sh -c`, `eval`,
 * `sudo`, `env VAR=x`, `xargs`, `nohup`, `time`) to find the real command words. The
 * unwrapping technique is borrowed from @gotgenes/pi-permission-system (MIT).
 */

import type { Command, Node, Word, WordPart } from "unbash";
import { parse } from "unbash";

/** Built-in read calls. `bash`, `write`, `edit` and any unknown tool are change calls. */
const BUILT_IN_READ_TOOLS = new Set(["read", "grep", "find", "ls"]);

/**
 * Tools that alter state and can never be reclassified as read-only, no matter what a config
 * says. Without this guard a `readOnlyTools` of `["bash","write","edit"]` would classify every
 * change call as a read and silently disable the gate.
 */
const NEVER_READ_ONLY = new Set(["bash", "write", "edit"]);

/**
 * Classify a tool call. `readOnlyTools` is the extra read-only list from config;
 * unknown tools are change calls (gated). `bash`/`write`/`edit` are always change calls —
 * config cannot mark them read-only.
 */
export function classifyTool(toolName: string, readOnlyTools: readonly string[] = []): "read" | "change" {
	if (BUILT_IN_READ_TOOLS.has(toolName)) return "read";
	if (NEVER_READ_ONLY.has(toolName)) return "change";
	if (readOnlyTools.includes(toolName)) return "read";
	return "change";
}

/**
 * The command words extracted from a bash command. `resolved` is false when the
 * command could not be parsed or a wrapper's inner command could not be determined;
 * an unresolved command can never match a session allow and always gates.
 */
export interface CommandWords {
	resolved: boolean;
	words: string[];
}

/** String wrappers whose real command lives in a `-c` operand (or a script argument). */
const STRING_C_WRAPPERS = new Set(["bash", "sh"]);

/**
 * Wrappers whose whole purpose is to run another command given as an argument, but which we
 * do NOT safely unwrap: the real command is a remote/container/interpreter context, or the
 * argument structure is too varied to resolve reliably. A command led by one of these is
 * marked unresolved so it can never match a session allow and always gates.
 * `builtin` and `script` are the same class as the issue's named wrappers; included too.
 */
const UNSAFE_WRAPPERS = new Set([
	"nice",
	"timeout",
	"command",
	"builtin",
	"exec",
	"script",
	"ssh",
	"docker",
	"npx",
]);

/** node/python running inline code rather than a script file — an arbitrary-code wrapper. */
const NODE_INTERPRETERS = new Set(["node", "nodejs"]);
const NODE_EVAL_FLAGS = new Set(["-e", "--eval", "-p", "--print"]);
const PYTHON_INTERPRETERS = new Set(["python", "python3", "python2"]);

/**
 * True when a command is an interpreter invoked to run inline code (`node -e`, `node -p`,
 * `python -c`), as opposed to a script file (`node app.js`). Inline code is an unresolvable
 * arbitrary-command wrapper; a script-file invocation stays a normal `node`/`python` word.
 */
function isInlineInterpreter(name: string, suffix: Word[]): boolean {
	if (NODE_INTERPRETERS.has(name)) return suffix.some((w) => NODE_EVAL_FLAGS.has(w.value));
	if (PYTHON_INTERPRETERS.has(name)) return suffix.some((w) => w.value === "-c");
	return false;
}

/**
 * Prefix wrappers: `<wrapper> [options] <real command...>`. Values map each wrapper to
 * the options that consume a following argument, so we can find where the real command
 * begins. Unknown leading `-flags` are treated as valueless (conservative — a misread
 * only affects allow matching and errs toward gating; hard-deny runs on the raw string).
 */
const PREFIX_WRAPPERS: Record<string, Set<string>> = {
	sudo: new Set([
		"-u",
		"--user",
		"-g",
		"--group",
		"-C",
		"--close-from",
		"-p",
		"--prompt",
		"-r",
		"--role",
		"-t",
		"--type",
		"-U",
		"--other-user",
	]),
	env: new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]),
	xargs: new Set([
		"-I",
		"-E",
		"-L",
		"-n",
		"-P",
		"-d",
		"-s",
		"-a",
		"--arg-file",
		"--delimiter",
		"--max-args",
		"--max-lines",
		"--max-procs",
		"--replace",
		"--max-chars",
	]),
	nohup: new Set(),
	time: new Set(["-o", "--output", "-f", "--format"]),
};

/**
 * Extract the command words of a bash command. Empty `words` with `resolved: true`
 * means the command runs nothing external (e.g. a bare assignment).
 */
export function extractCommandWords(rawCommand: string): CommandWords {
	const script = parse(rawCommand);
	if (script.errors && script.errors.length > 0) {
		return { resolved: false, words: [] };
	}
	const acc: string[] = [];
	const resolved = collectFromNodes(script.commands, rawCommand, acc);
	return { resolved, words: dedupe(acc) };
}

function dedupe(words: string[]): string[] {
	return [...new Set(words)];
}

/** Walk a list of AST nodes, appending command words to `acc`. Returns false on any unresolved wrapper. */
function collectFromNodes(nodes: Node[], src: string, acc: string[]): boolean {
	let ok = true;
	for (const node of nodes) {
		if (!collectFromNode(node, src, acc)) ok = false;
	}
	return ok;
}

/** Walk one AST node. Returns false when a wrapper's inner command could not be resolved. */
function collectFromNode(node: Node, src: string, acc: string[]): boolean {
	switch (node.type) {
		case "Statement":
			return collectFromNode(node.command, src, acc);
		case "Command":
			return collectFromCommand(node, src, acc);
		case "Pipeline":
		case "AndOr":
			return collectFromNodes(node.commands, src, acc);
		case "Subshell":
		case "BraceGroup":
			return collectFromNodes(node.body.commands, src, acc);
		case "CompoundList":
			return collectFromNodes(node.commands, src, acc);
		case "If":
			return [
				collectFromNode(node.clause, src, acc),
				collectFromNode(node.then, src, acc),
				node.else ? collectFromNode(node.else, src, acc) : true,
			].every(Boolean);
		case "For":
		case "Select":
		case "While":
			return (
				collectFromNode(node.body, src, acc) &&
				("clause" in node && node.clause ? collectFromNode(node.clause, src, acc) : true)
			);
		case "Case":
			return node.items.every((item: { body: Node }) => collectFromNode(item.body, src, acc));
		case "Function":
			return collectFromNode(node.body, src, acc);
		default:
			// TestCommand, ArithmeticCommand, Coproc, etc. run nothing external we gate on.
			return true;
	}
}

/**
 * Walk a word's parts (recursing into double-quoted / locale-string / other nested parts)
 * for command substitution (`$( )`, backticks) or process substitution (`<( )`, `>( )`).
 * When found, the inner script's command words are collected into `acc` for the record —
 * but the caller marks the whole call unresolved regardless, so it always gates.
 */
function partsHaveSubstitution(parts: WordPart[] | undefined, acc: string[]): boolean {
	if (!parts) return false;
	let found = false;
	for (const part of parts) {
		if (part.type === "CommandExpansion" || part.type === "ProcessSubstitution") {
			found = true;
			if (part.inner) {
				const parsed = parse(part.inner);
				if (!(parsed.errors && parsed.errors.length > 0)) collectFromNodes(parsed.commands, part.inner, acc);
			}
		} else if ("parts" in part && Array.isArray(part.parts)) {
			// DoubleQuoted / LocaleString / ExtendedGlob / BraceExpansion can nest substitutions.
			if (partsHaveSubstitution(part.parts as WordPart[], acc)) found = true;
		}
	}
	return found;
}

/** True when any word of a command (name, assignments, arguments, redirects) hides a substitution. */
function commandHasSubstitution(cmd: Command, acc: string[]): boolean {
	let found = false;
	if (partsHaveSubstitution(cmd.name?.parts, acc)) found = true;
	// A variable in command position (`x=rm; $x -rf /`, `${cmd} …`) is not a literal word, so the
	// real command cannot be known statically. Literal words only: mark it unresolved.
	if (
		cmd.name?.parts?.some((part) => part.type === "SimpleExpansion" || part.type === "ParameterExpansion")
	) {
		found = true;
	}
	for (const p of cmd.prefix) {
		if (partsHaveSubstitution(p.value?.parts, acc)) found = true;
		if (p.array) for (const w of p.array) if (partsHaveSubstitution(w.parts, acc)) found = true;
	}
	for (const w of cmd.suffix) if (partsHaveSubstitution(w.parts, acc)) found = true;
	for (const r of cmd.redirects) {
		if (partsHaveSubstitution(r.target?.parts, acc)) found = true;
		if (partsHaveSubstitution(r.body?.parts, acc)) found = true; // heredoc body expansions
	}
	return found;
}

/** Resolve the command word(s) of a simple command, unwrapping shell wrappers. */
function collectFromCommand(cmd: Command, src: string, acc: string[]): boolean {
	// Command/process substitution hides the real command from allow matching. Record what we
	// can, but mark the call unresolved so it always gates.
	if (commandHasSubstitution(cmd, acc)) {
		if (cmd.name?.value !== undefined) acc.push(cmd.name.value);
		return false;
	}

	const name = cmd.name?.value;
	if (name === undefined) return true; // assignment-only command; runs nothing external

	// Wrappers that run another command we can't safely resolve → unresolved, so they gate.
	if (UNSAFE_WRAPPERS.has(name) || isInlineInterpreter(name, cmd.suffix)) {
		acc.push(name);
		return false;
	}

	if (STRING_C_WRAPPERS.has(name)) {
		const inner = operandAfterFlag(cmd.suffix, "-c");
		if (inner === undefined) {
			// `bash script.sh` — the wrapper itself is the command word.
			acc.push(name);
			return true;
		}
		return collectFromNodes(parse(inner).commands, inner, acc);
	}

	if (name === "eval") {
		const joined = cmd.suffix
			.map((w) => w.value)
			.join(" ")
			.trim();
		if (joined === "") return true;
		const parsed = parse(joined);
		if (parsed.errors && parsed.errors.length > 0) return false;
		return collectFromNodes(parsed.commands, joined, acc);
	}

	if (name in PREFIX_WRAPPERS) {
		const argOpts = PREFIX_WRAPPERS[name];
		const start = firstRealSuffixWord(cmd.suffix, argOpts);
		if (start === undefined) {
			// Wrapper with no inner command (e.g. bare `env`); nothing runs.
			return true;
		}
		const innerSrc = src.slice(start.pos, cmd.end).trim();
		if (innerSrc === "") return false;
		const parsed = parse(innerSrc);
		if (parsed.errors && parsed.errors.length > 0) return false;
		return collectFromNodes(parsed.commands, innerSrc, acc);
	}

	acc.push(name);
	return true;
}

/**
 * Resolved targets of every output redirection in a bash command (`>`, `>>`, `>|`, `&>`, …).
 * `unbash` concatenates quote parts into `target.value`, so shell obfuscation like
 * `pi-gu''ru.json` resolves to `pi-guru.json` — the real path a hard-deny path rule must see
 *. Input redirections (`<`, `<<`) are skipped: reading a protected file is not a
 * change. An unparseable command yields no targets (it already gates as unresolved).
 */
export function extractRedirectTargets(rawCommand: string): string[] {
	const script = parse(rawCommand);
	if (script.errors && script.errors.length > 0) return [];
	const targets: string[] = [];
	collectRedirectTargets(script as unknown, targets);
	return targets;
}

/** Deep-walk any parse node, collecting the resolved target of each output redirection. */
function collectRedirectTargets(node: unknown, acc: string[]): void {
	if (!node || typeof node !== "object") return;
	if (Array.isArray(node)) {
		for (const child of node) collectRedirectTargets(child, acc);
		return;
	}
	const obj = node as Record<string, unknown>;
	const redirects = obj.redirects;
	if (Array.isArray(redirects)) {
		for (const r of redirects) {
			const op = (r as { operator?: unknown }).operator;
			const target = (r as { target?: { value?: unknown } }).target;
			if (typeof op === "string" && op.includes(">") && target && typeof target.value === "string") {
				acc.push(target.value);
			}
		}
	}
	for (const key of Object.keys(obj)) {
		if (key === "redirects") continue; // handled above; don't descend into it again
		collectRedirectTargets(obj[key], acc);
	}
}

/**
 * Writing commands whose *every* non-option operand is a path they create, modify, or delete
 *. A mode/owner/size/script operand collected alongside is harmless: it can never
 * match an anchored protected-path rule.
 */
const ALL_OPERAND_WRITERS = new Set(["tee", "truncate", "shred", "rm", "chmod", "chown"]);

/**
 * Writing commands whose leading operands are *read sources* and only the destination is written
 *. Flagging their sources would re-introduce the false positive #6/D6 warned about
 * (`cp ~/.bashrc backup` reads `.bashrc`; it does not write it), so only the destination is taken.
 */
const DEST_ONLY_WRITERS = new Set(["cp", "mv", "install", "ln"]);

/** `-t DIR` / `--target-directory=DIR`: names the destination for the dest-only writers. */
const TARGET_DIR_FLAGS = new Set(["-t", "--target-directory"]);

/** Escalation wrappers stripped to reach the real writing command. */
const ARG_TARGET_WRAPPERS = new Set(["sudo", "doas"]);

/**
 * Resolved path arguments that a bash command *writes to*, for a known list of writing commands
 *: `sed -i`, `tee`, `cp`, `mv`, `install`, `truncate`, `shred`, `rm`, `ln`, `chmod`,
 * `chown`, and `dd of=`. These are the targets that never appear as a redirection, so
 * `extractRedirectTargets` misses them; `hardDenyBash` matches them against the same anchored
 * `path` rules, so a `sed -i … ~/.zshrc` or `tee ~/.bashrc` is caught, not merely gated.
 *
 * Sources are deliberately excluded (dest-only writers, `dd if=`) so reading a protected path is
 * never flagged. A leading `sudo`/`doas` is unwrapped; deeper/indirect wrappers are not (D3) —
 * hard-deny is a tripwire, not a net. An unparseable command yields no targets (it already gates).
 */
export function extractArgTargets(rawCommand: string): string[] {
	const script = parse(rawCommand);
	if (script.errors && script.errors.length > 0) return [];
	const commands: Command[] = [];
	collectCommands(script as unknown, commands);
	const targets: string[] = [];
	for (const cmd of commands) targetsOfCommand(cmd, targets);
	return targets;
}

/** Deep-walk any parse node, collecting every simple `Command` node. */
function collectCommands(node: unknown, acc: Command[]): void {
	if (!node || typeof node !== "object") return;
	if (Array.isArray(node)) {
		for (const child of node) collectCommands(child, acc);
		return;
	}
	const obj = node as Record<string, unknown>;
	if (obj.type === "Command") acc.push(obj as unknown as Command);
	for (const key of Object.keys(obj)) collectCommands(obj[key], acc);
}

/** Append the write-target path arguments of one simple command to `acc`. */
function targetsOfCommand(cmd: Command, acc: string[]): void {
	let name = cmd.name?.value;
	if (name === undefined) return;
	let args = cmd.suffix.map((w) => w.value);

	// Strip a leading sudo/doas so `sudo tee ~/.bashrc` resolves to `tee ~/.bashrc` (D3).
	while (name !== undefined && ARG_TARGET_WRAPPERS.has(name)) {
		let i = 0;
		while (i < args.length && args[i].startsWith("-")) {
			const consumesArg = PREFIX_WRAPPERS.sudo.has(args[i]);
			i += consumesArg ? 2 : 1;
		}
		name = args[i];
		args = args.slice(i + 1);
	}
	if (name === undefined) return;

	if (name === "dd") {
		for (const a of args) {
			if (a.startsWith("of=")) acc.push(a.slice(3));
		}
		return;
	}
	if (name === "sed") {
		if (args.some((a) => a === "--in-place" || a.startsWith("--in-place=") || /^-i/.test(a))) {
			acc.push(...operands(args));
		}
		return;
	}
	if (ALL_OPERAND_WRITERS.has(name)) {
		acc.push(...operands(args));
		return;
	}
	if (DEST_ONLY_WRITERS.has(name)) {
		const dest = destinationOf(args);
		if (dest !== undefined) acc.push(dest);
	}
}

/** Non-option operands: words not starting with `-`, plus everything after a `--` end-of-options. */
function operands(args: string[]): string[] {
	const out: string[] = [];
	let afterDoubleDash = false;
	for (const a of args) {
		if (afterDoubleDash) {
			out.push(a);
		} else if (a === "--") {
			afterDoubleDash = true;
		} else if (!a.startsWith("-")) {
			out.push(a);
		}
	}
	return out;
}

/** The destination a dest-only writer writes to: the `-t`/`--target-directory` operand, else the last operand. */
function destinationOf(args: string[]): string | undefined {
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a.startsWith("--target-directory=")) return a.slice("--target-directory=".length);
		if (TARGET_DIR_FLAGS.has(a)) return args[i + 1];
		if (a === "--") break; // options end; fall through to the last-operand rule
	}
	const ops = operands(args);
	return ops[ops.length - 1];
}

/** The word following `flag` in a suffix list, or undefined if not present. */
function operandAfterFlag(suffix: Word[], flag: string): string | undefined {
	for (let i = 0; i < suffix.length; i++) {
		if (suffix[i].value === flag) return suffix[i + 1]?.value;
	}
	return undefined;
}

/**
 * Find the first suffix word that begins the real command: skip leading options and
 * (for env) `VAR=value` assignments, consuming the argument of any option in `argOpts`.
 */
function firstRealSuffixWord(suffix: Word[], argOpts: Set<string>): Word | undefined {
	for (let i = 0; i < suffix.length; i++) {
		const w = suffix[i];
		if (w.value.startsWith("-")) {
			if (argOpts.has(w.value)) i++; // consume the option's argument
			continue;
		}
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w.value)) continue; // env assignment
		return w;
	}
	return undefined;
}
