/**
 * File-content risk facts via `@ast-grep/napi`).
 *
 * Structural matching a regex cannot do: a subprocess/exec/eval call whose argument is a *constructed*
 * string (concatenation, f-string, template, variable), a network call to a *literal external* host,
 * and code that opens a *literal credential or system path*. The three grammars (python, bash,
 * javascript) are registered once per process, lazily, through a synchronous `createRequire` — so
 * `assess` stays synchronous and the native addon loads on first use, not at import.
 *
 * Fails soft: if the native module or a grammar cannot load, the whole path degrades to a single
 * `content-analysis-unavailable` info fact and every dependency-free rule (bash, paths, secrets) still
 * runs. Content facts never impose a floor — file content is weaker evidence than a resolved path.
 */

import { createRequire } from "node:module";
import { extname } from "node:path";
import { isCredentialPath, isSystemPath, resolvePath } from "./paths.ts";
import type { AssessContext, Fact } from "./types.ts";

const require = createRequire(import.meta.url);

/** The minimal ast-grep surface this module uses, so nothing here is typed `any`. */
interface SgNode {
	kind(): string;
	text(): string;
	getMatch(name: string): SgNode | null;
	findAll(matcher: unknown): SgNode[];
}
interface SgRoot {
	root(): SgNode;
}
interface NapiModule {
	parse(lang: string, src: string): SgRoot;
	registerDynamicLanguage(langs: Record<string, unknown>): void;
}

/** `undefined` = not yet tried, `null` = load failed, else the parse function. */
let parseFn: ((lang: string, src: string) => SgRoot) | null | undefined;

/** Lazily load + register the grammars once; return the parse function, or null if unavailable. */
function loadParse(): ((lang: string, src: string) => SgRoot) | null {
	if (parseFn !== undefined) return parseFn;
	try {
		const napi = require("@ast-grep/napi") as NapiModule;
		const bash = require("@ast-grep/lang-bash");
		const python = require("@ast-grep/lang-python");
		const javascript = require("@ast-grep/lang-javascript");
		napi.registerDynamicLanguage({ bash, python, javascript });
		parseFn = (lang, src) => napi.parse(lang, src);
	} catch {
		parseFn = null;
	}
	return parseFn;
}

/** For tests: reset the memoised engine so a fresh load path can be exercised. */
export function resetContentEngineForTest(): void {
	parseFn = undefined;
}

/** For tests: pin the engine to the failed state, to exercise graceful degradation. */
export function forceContentUnavailableForTest(): void {
	parseFn = null;
}

/** The ast-grep language for a file extension, or null when we run no content rules for it. */
function languageOf(filePath: string): "python" | "javascript" | null {
	const ext = extname(filePath).toLowerCase();
	if (ext === ".py" || ext === ".pyw") return "python";
	if ([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts"].includes(ext)) return "javascript";
	return null;
}

/** One content rule: an ast-grep pattern, and a check turning a match into a fact (or null). */
interface ContentRule {
	pattern: string;
	make(node: SgNode, ctx: AssessContext): Fact | null;
}

/**
 * Assess the content being written to `filePath`. Returns [] when the file type has no content rules;
 * a single `content-analysis-unavailable` info fact when ast-grep cannot load; otherwise the matched
 * content facts (deduped). `content` is the full text (write body, or an edit's joined new text).
 */
export function assessContent(filePath: string, content: string, ctx: AssessContext): Fact[] {
	const lang = languageOf(filePath);
	if (!lang || content.trim() === "") return [];
	const parse = loadParse();
	if (!parse) {
		return [
			{
				id: "content-analysis-unavailable",
				text: "pi-guru could not analyze this file's content (analyzer unavailable)",
				severity: "info",
				evidence: filePath,
			},
		];
	}
	let root: SgNode;
	try {
		root = parse(lang, content).root();
	} catch {
		return [
			{
				id: "content-analysis-unavailable",
				text: "pi-guru could not analyze this file's content (parse failed)",
				severity: "info",
				evidence: filePath,
			},
		];
	}
	const rules = lang === "python" ? PYTHON_RULES : JAVASCRIPT_RULES;
	const facts: Fact[] = [];
	for (const rule of rules) {
		for (const node of root.findAll({ rule: { pattern: rule.pattern } })) {
			const fact = rule.make(node, ctx);
			if (fact) facts.push(fact);
		}
	}
	return dedupe(facts);
}

// --- shared match helpers -------------------------------------------------

/** Plain single string literal value (quotes/backticks stripped), or null for anything constructed. */
function literalString(node: SgNode | null): string | null {
	if (!node) return null;
	const kind = node.kind();
	if (kind !== "string" && kind !== "concatenated_string") return null;
	const text = node.text();
	// A python f-string / js template with substitution is not a plain literal.
	if (/^[a-zA-Z]*f/i.test(text) && /^[a-zA-Z]/.test(text)) return null;
	return stripQuotes(text);
}

/** Strip surrounding quotes/backticks and any string prefix (r, b, u, f) from a literal's text. */
function stripQuotes(text: string): string {
	const m = /^[a-zA-Z]*(['"`])([\s\S]*)\1$/.exec(text);
	return m ? m[2] : text;
}

/** True when a call argument is a *constructed* value, not a plain string/number literal. */
function isConstructed(node: SgNode | null): boolean {
	if (!node) return false;
	const kind = node.kind();
	if (kind === "string") {
		const text = node.text();
		// f-string / template with interpolation counts as constructed.
		if (kind === "string" && /\{[^}]*\}/.test(text) && /^[a-zA-Z]*f/i.test(text)) return true;
		return false;
	}
	if (kind === "template_string") return node.text().includes("${");
	if (kind === "concatenated_string" || kind === "integer" || kind === "float" || kind === "number")
		return false;
	if (kind === "true" || kind === "false" || kind === "none" || kind === "null") return false;
	return true; // identifier, binary_operator/expression, call, attribute, member_expression, subscript, …
}

/** The external hostname of a literal URL, or null (relative, malformed, or local). */
function externalHost(literal: string | null): string | null {
	if (!literal) return null;
	let host: string;
	try {
		host = new URL(literal).hostname;
	} catch {
		return null;
	}
	if (host === "") return null;
	if (["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"].includes(host)) return null;
	return host;
}

function credFact(node: SgNode, ctx: AssessContext): Fact | null {
	const p = literalString(node.getMatch("P"));
	if (!p) return null;
	const abs = resolvePath(p, ctx);
	if (!abs || !isCredentialPath(abs, ctx.home)) return null;
	return {
		id: "content-reads-credential",
		text: "code reads a credential or key file",
		severity: "high",
		evidence: abs,
	};
}

function systemWriteFact(node: SgNode, ctx: AssessContext, mode?: SgNode | null): Fact | null {
	if (mode && !/["'][^"']*[wax+]/.test(mode.text())) return null;
	const p = literalString(node.getMatch("P"));
	if (!p) return null;
	const abs = resolvePath(p, ctx);
	if (!abs || !isSystemPath(abs, ctx.home)) return null;
	return {
		id: "content-writes-system-path",
		text: "code writes to a system path",
		severity: "medium",
		evidence: abs,
	};
}

function constructedFact(node: SgNode, callee: string): Fact | null {
	if (!isConstructed(node.getMatch("A"))) return null;
	return {
		id: "content-subprocess-constructed",
		text: "code runs a dynamically constructed command",
		severity: "medium",
		evidence: callee,
	};
}

function networkFact(node: SgNode): Fact | null {
	const host = externalHost(literalString(node.getMatch("U")));
	if (!host) return null;
	return {
		id: "content-network-literal-host",
		text: "code contacts a literal external host",
		severity: "medium",
		evidence: host,
	};
}

// --- rule tables ----------------------------------------------------------

const PYTHON_RULES: ContentRule[] = [
	{ pattern: "os.system($A)", make: (n) => constructedFact(n, "os.system") },
	{ pattern: "os.popen($A)", make: (n) => constructedFact(n, "os.popen") },
	{ pattern: "eval($A)", make: (n) => constructedFact(n, "eval") },
	{ pattern: "exec($A)", make: (n) => constructedFact(n, "exec") },
	// subprocess with shell=True: the whole call text carries the kwarg; fire when it constructs a command.
	{ pattern: "subprocess.run($$$A)", make: (n) => shellTrueFact(n, "subprocess.run") },
	{ pattern: "subprocess.call($$$A)", make: (n) => shellTrueFact(n, "subprocess.call") },
	{ pattern: "subprocess.Popen($$$A)", make: (n) => shellTrueFact(n, "subprocess.Popen") },
	{ pattern: "subprocess.check_output($$$A)", make: (n) => shellTrueFact(n, "subprocess.check_output") },
	{ pattern: "requests.get($U)", make: (n) => networkFact(n) },
	{ pattern: "requests.post($U)", make: (n) => networkFact(n) },
	{ pattern: "requests.put($U)", make: (n) => networkFact(n) },
	{ pattern: "urllib.request.urlopen($U)", make: (n) => networkFact(n) },
	{ pattern: "urlopen($U)", make: (n) => networkFact(n) },
	{ pattern: "open($P)", make: (n, c) => credFact(n, c) },
	{ pattern: "open($P, $M)", make: (n, c) => credFact(n, c) ?? systemWriteFact(n, c, n.getMatch("M")) },
];

const JAVASCRIPT_RULES: ContentRule[] = [
	{ pattern: "child_process.exec($A)", make: (n) => constructedFact(n, "child_process.exec") },
	{ pattern: "child_process.execSync($A)", make: (n) => constructedFact(n, "child_process.execSync") },
	{ pattern: "cp.exec($A)", make: (n) => constructedFact(n, "cp.exec") },
	{ pattern: "cp.execSync($A)", make: (n) => constructedFact(n, "cp.execSync") },
	{ pattern: "eval($A)", make: (n) => constructedFact(n, "eval") },
	{ pattern: "new Function($A)", make: (n) => constructedFact(n, "new Function") },
	{ pattern: "fetch($U)", make: (n) => networkFact(n) },
	{ pattern: "axios($U)", make: (n) => networkFact(n) },
	{ pattern: "axios.get($U)", make: (n) => networkFact(n) },
	{ pattern: "axios.post($U)", make: (n) => networkFact(n) },
	{ pattern: "https.get($U)", make: (n) => networkFact(n) },
	{ pattern: "http.get($U)", make: (n) => networkFact(n) },
	{ pattern: "fs.readFileSync($P)", make: (n, c) => credFact(n, c) },
	{ pattern: "fs.readFileSync($P, $M)", make: (n, c) => credFact(n, c) },
	{ pattern: "fs.readFile($P, $$$A)", make: (n, c) => credFact(n, c) },
	{ pattern: "readFileSync($P)", make: (n, c) => credFact(n, c) },
	{ pattern: "fs.writeFileSync($P, $$$A)", make: (n, c) => systemWriteFact(n, c) },
	{ pattern: "fs.writeFile($P, $$$A)", make: (n, c) => systemWriteFact(n, c) },
	{ pattern: "writeFileSync($P, $$$A)", make: (n, c) => systemWriteFact(n, c) },
];

/** `subprocess.*` fires only with `shell=True` and a constructed command as the first argument. */
function shellTrueFact(node: SgNode, callee: string): Fact | null {
	if (!node.text().includes("shell=True")) return null;
	return {
		id: "content-subprocess-constructed",
		text: "code runs a shell subprocess (shell=True)",
		severity: "medium",
		evidence: callee,
	};
}

function dedupe(facts: Fact[]): Fact[] {
	const seen = new Set<string>();
	const out: Fact[] = [];
	for (const f of facts) {
		const key = `${f.id} ${f.evidence}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(f);
	}
	return out;
}
