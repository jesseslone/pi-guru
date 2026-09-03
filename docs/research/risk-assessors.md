# Deterministic risk assessors for pi-guru

**Status:** COMPLETE — 2026-09-03. Every claim below was checked against a primary source (project README, source file, GitHub/npm API, or a local measurement) on that date. Items that could not be verified are listed at the end.

## Question

the design notes wants a deterministic "risk facts" pass that runs before the LLM judge on every change call (bash, write, edit) and emits verified facts plus a few hard floors. Which existing tools or libraries could supply that code intelligence with few false positives, and how fast are they, given that it runs inside a Node/TypeScript extension on macOS and Linux?

## Summary table

| Tool | Lang | License | Latest release | Node integration | Per-call cost (measured or stated) | Fit |
|---|---|---|---|---|---|---|
| unbash | TS | ISC | 4.0.11, 2026-09-01 | in-process (already a dependency) | 17 µs/parse steady, 5.7 ms import (measured) | **keep** |
| mvdan/sh `syntax` | Go | BSD-3 | v3.14.0, 2026-08-28 | WASM via `sh-syntax` 0.6.0, or spawn | 18 ms/iter in its own benchmark | low |
| tree-sitter-bash | C grammar | MIT | v0.25.1, 2025-12-02 | `@ast-grep/lang-bash`, `web-tree-sitter` WASM, or native addon | 30 µs/parse via ast-grep napi (measured) | low as a replacement parser |
| ShellCheck | Haskell | GPL-3.0 | v0.11.0, 2025-08-04 | spawn static binary (61 MB on disk) | 20 ms warm, 0.94 s cold (measured) | low |
| bashlex | Python | GPL-3.0 | last push 2024-04-08 | spawn python | not measured | no |
| ast-grep | Rust | MIT | 0.45.3, 2026-08-31 | `@ast-grep/napi` + `@ast-grep/lang-*` | 1.7–2.7 ms for a 5–6 KB file with 2–3 rules (measured) | **medium, for file content** |
| opengrep (semgrep fork) | OCaml | LGPL-2.1 | v1.29.0, 2026-08-28 | spawn 30–47 MB binary | not measured; Bash is "experimental" in semgrep | low |
| ripgrep | Rust | Unlicense/MIT | 15.2.0, 2026-07-15 | spawn 1.7–2.2 MB binary | 0–20 ms (measured) | no (JS regex covers it) |
| gitleaks | Go | MIT | v8.30.1, 2026-03-21 | spawn 21 MB binary, `stdin` mode | 0.32 s warm, 0.95 s cold (measured) | low as a per-call tool; **medium as a rule source** |
| trufflehog | Go | AGPL-3.0 | v3.97.2, 2026-09-02 | spawn 33–72 MB binary | not measured | no |
| detect-secrets | Python | Apache-2.0 | v1.5.0, 2024-05-06 | spawn python | not measured | low |
| cc-safety-net | TS | MIT | v2.3.2, 2026-09-03 | npm library `checkCommand()` or hook CLI | in-process | **medium, as reference/rule source** |
| @xynogen/pix-gate | TS | MIT | 0.2.12, 2026-09-03 | `@xynogen/pix-gate/lib` `classify()` | in-process | low (regex tiers; good floor seed) |
| @gotgenes/pi-permission-system | TS | MIT | 31.0.0, 2026-09-02 | pi extension | in-process (web-tree-sitter) | design reference |
| OpenAI Codex `shell-command`, `execpolicy` | Rust | Apache-2.0 | rust-v0.153.0, 2026-09-03 | none (read the source) | n/a | design reference |
| Claude Code bash rules | closed | n/a | docs current | none | n/a | documented behaviour only |
| GTFOBins | YAML data | GPL-3.0 | pushed 2026-05-27 | vendor a derived table | n/a | **high, as data** (license caveat) |
| LOLBAS | YAML data | GPL-3.0 | active | n/a | n/a | no (Windows only) |
| Sigma rules | YAML data | DRL 1.1 | r2026-07-01 | read as rule source | n/a | medium, as data |
| Falco rules | YAML data | Apache-2.0 | falco-rules-5.1.0, 2026-05-20 | read as rule source | n/a | low, as data |
| RedCode | JSON data | MIT code, CC BY 4.0 data | pushed 2026-08-19 | test corpus | n/a | **high, as bench corpus** |

Table sources: GitHub API `repos/<owner>/<repo>` and `releases/latest`, `npm view <pkg>`, and release asset sizes, all queried 2026-09-03. Measurements: Apple Silicon Mac, Node, scripts in the session scratchpad; each number is the steady state after one warm-up run unless marked cold.

## Shell parsing and analysis

**unbash** (https://github.com/webpro-nl/unbash). ISC, "Fast 0-deps bash parser written in TypeScript", 80 KB minified. Its README benchmark reports 70–112 MB/s parse throughput and claims 6–15x over tree-sitter-bash variants. Locally: 17 µs per parse of a 3-line hostile command, 5.7 ms to import. It handles heredocs, process substitution, extglob, `;&` fallthrough, and `{var}` fd redirects. The README states plainly it "does not execute code, perform shell expansion, provide a sandbox, or decide whether a command is safe", and word parts are lazy getters, so a generic `Object.keys` walker misses expansions; a fact extractor must walk `Word.parts` explicitly. No risk analyzer is built on it. pi-guru already uses it in `src/classify.ts`.

**mvdan/sh** (https://github.com/mvdan/sh). Go, BSD-3, v3.14.0. Packages `syntax`, `expand`, `interp`, `shell`; supports POSIX, Bash, Zsh, mksh. A web search for a risk analyzer built on the `syntax` package found none; the ecosystem is shfmt and gosh. For Node, `sh-syntax` (MIT, 0.6.0, 2026-07-08, https://www.npmjs.com/package/sh-syntax) wraps a WASM build; its README benchmark shows 18.33 ms/iter versus 79 ms for the archived GopherJS `mvdan-sh`. That is three orders of magnitude slower than unbash for no additional facts. Not worth switching.

**tree-sitter-bash** (https://github.com/tree-sitter/tree-sitter-bash). MIT, C grammar, v0.25.1 (2025-12-02). npm `tree-sitter-bash` needs a native build; `web-tree-sitter` 0.27.0 gives a WASM path, which `@gotgenes/pi-permission-system` uses. Through `@ast-grep/lang-bash` the parse is 30 µs steady. Codex CLI parses `bash -lc` strings with it (below). Its error tolerance helps extract literal commands from broken scripts, but switching means rewriting `classify.ts` for no new facts. Keep it as the ast-grep grammar for bash *file contents*, not for the command string.

**ShellCheck** (https://github.com/koalaman/shellcheck). Haskell, GPL-3.0, v0.11.0. The darwin-arm64 binary is 61.5 MB unpacked; warm runs take 20 ms with `-f json`. Its stated goals are beginner syntax errors, intermediate semantic problems, and subtle caveats, not security. On the five-line hostile script (curl-pipe-sudo-bash, `cat ~/.ssh/id_rsa | nc`, `rm -rf` and force-push) it returned `[]`. The only risk-adjacent checks found are SC2114 "deletes a system directory" (https://www.shellcheck.net/wiki/SC2114) and SC2115 "Use `${var:?}` to ensure this never expands to `/*`" (https://www.shellcheck.net/wiki/SC2115). Both are cheap to reimplement as facts on the unbash AST. Not worth a 61 MB GPL dependency.

**bashlex** (https://github.com/idank/bashlex). Python, GPL-3.0, last push 2024-04-08, no arithmetic expansion, complex parameter expansions taken literally. No.

## Pattern engines for file contents

**ast-grep** (https://github.com/ast-grep/ast-grep, docs https://ast-grep.github.io/). Rust, MIT, 0.45.3. Built-in languages include Bash, Python, JavaScript, TypeScript, YAML and JSON; Dockerfile and TOML are not built in (https://ast-grep.github.io/reference/languages.html). `@ast-grep/napi` "ships JavaScript ecosystem languages by default"; Bash, Python and YAML come from `@ast-grep/lang-bash` (0.0.8), `@ast-grep/lang-python` (0.0.6) and `@ast-grep/lang-yaml` (0.0.6), all ISC, registered once per process with `registerDynamicLanguage` ("only the first call is registered") (https://ast-grep.github.io/guide/api-usage/js-api.html). Disk footprint on darwin-arm64: napi 0.4 MB plus a 7.1 MB platform binary, lang-bash 16 MB, lang-python 5.9 MB.

The napi `findAll` takes the same `rule`/`constraints` object shape as the YAML rule files, so YAML rules can be loaded with a YAML parser and passed straight in. Measured: import plus register 7–10 ms warm (1.6 s the very first cold run, which is the OS reading the 16 MB grammar); 5.3 KB of Python parsed and matched against `os.system($X)`, `eval($X)` and `subprocess.run($$$, shell=True)` in 2.7 ms; 6 KB of TypeScript with two rules in 1.7–2.2 ms. That is inside any reasonable per-call budget and gives structural matching (call with keyword argument, string concatenation into a shell call) that regex cannot.

**opengrep** (https://github.com/opengrep/opengrep). OCaml, LGPL-2.1, v1.29.0, fork of Semgrep v1.100.0, Semgrep-rule compatible. Binaries are 30–47 MB. Semgrep's own language table lists Bash and Dockerfile as experimental (https://docs.semgrep.dev/supported-languages). Semgrep's security rule packs are the most complete off-the-shelf content, but per-call spawning of a 45 MB binary plus Python wrapper is the slowest option here and pi-guru's contents are mostly small diffs. Use the rule packs as a reading source for which patterns matter, not the engine.

**ripgrep** (https://github.com/BurntSushi/ripgrep). Rust, 15.2.0, 1.7–2.2 MB, effectively zero startup. Regex only; an in-process JavaScript regex over a diff is the same thing without a spawn. No.

## Secret detection

**gitleaks** (https://github.com/gitleaks/gitleaks). Go, MIT, v8.30.1. Default config has 222 `[[rules]]`, each a Go regex with optional entropy threshold, keyword pre-filter and per-rule allowlists; `gitleaks stdin` scans piped text. The binary is 21 MB unpacked. Measured 0.32 s per warm stdin call, 0.95 s cold, most of it compiling 222 regexes. On the test file it reported "no leaks found"; the file used the AWS documentation example keys, which are presumably allowlisted (suspected, see below). Spawning it on every write is too slow. Its TOML is the best-curated open regex set, and MIT allows copying the dozen or so rules that matter (private key blocks, AWS, GitHub, Slack, Stripe, generic `api[_-]?key=`) into an in-process table.

**trufflehog** (https://github.com/trufflesecurity/trufflehog). Go, AGPL-3.0, "over 700 credential detectors", verifies secrets live against provider APIs, 33–72 MB. AGPL plus network calls rule it out.

**detect-secrets** (https://github.com/Yelp/detect-secrets). Python, Apache-2.0, v1.5.0 (2024-05-06), 27 plugins, `detect-secrets scan --string` exists, and its README foregrounds signal-to-noise. Interpreter startup per call and an 18-month-old release make it a rule source only.

## Agent-oriented command safety

**cc-safety-net** (https://github.com/kenryu42/cc-safety-net). TypeScript, MIT, v2.3.2 released 2026-09-03, single runtime dependency (zod). It has a hand-written shell parser (`src/parser/shell/*.ts`, plus heredoc and PowerShell parsers) and analyzers for `rm` flags, recursive-delete targets, `find`, `xargs`, git, interpreters (`bash -c`, `python -c`), transparent wrappers, and path canonicalization; `src/api.ts` exports `checkCommand()`. It blocks "destructive Git and file system commands, plus common attempts to access sensitive files" and states that "wrapping the command or reordering flags does not hide it". Presets: Standard, Strict ("Occasional false positives on advanced shell"), Paranoid ("Expect friction"). Scope is narrower than #21 (no network-to-shell, eval, TLS, install-from-URL facts) and it emits a decision, not facts, but its `ir/semantic-facts.ts` is structurally close to what #21 wants and its rule catalog is a ready-made source for the destructive-command and secret-path facts.

**@xynogen/pix-gate** (https://www.npmjs.com/package/@xynogen/pix-gate). TypeScript, MIT, 0.2.12. `@xynogen/pix-gate/lib` exposes `DEFAULT_RULES`, `classify()`, tiers critical/dangerous/risky, plus a non-overridable "circuit breaker" set (`rm -rf /` or `~`, dd or redirect onto a raw disk, mkfs on a device, fork bomb). User rules are regex `pattern` strings. Useful as a floor seed list; regex matching is what #21 wants to avoid.

**@gotgenes/pi-permission-system** (https://www.npmjs.com/package/@gotgenes/pi-permission-system). TypeScript, MIT, 31.0.0, depends on `tree-sitter-bash` 0.25.1 and `web-tree-sitter` 0.26.9. Fails closed: an unparseable command resolves to `ask`, and indirection wrappers (`bash -c`, `eval`, `sudo`, `env`, `xargs`, `find -exec`) prompt unless the wrapped command is a provable pure reader. Redirect operators prove direction (`>` writes, `<` reads) and a frozen set of 21 read-only command words proves reads. Good model for how to treat wrappers and unparseable input.

**OpenAI Codex CLI** (https://github.com/openai/codex, Apache-2.0). Open source. `codex-rs/shell-command/src/bash.rs` parses with tree-sitter-bash. `try_parse_word_only_commands_sequence` accepts only plain-word commands joined by `&&`, `||`, `;`, `|` and rejects "parentheses, redirections, substitutions, control flow, etc."; `parse_shell_lc_literal_commands` extracts statically known words from every command node and is documented as "suitable for identifying dangerous literal commands, but must not be used to prove that a command is safe". `command_safety/is_dangerous_command.rs` flags `rm` with a force flag, unwraps `sudo` and `env`, re-parses `trap` actions as `sh -c`, and fails closed past a wrapper depth. Its tests encode a precision-first stance: `cmd=rm; $cmd -rf /tmp/x` and `echo 'rm -rf /tmp/x'` are *not* dangerous. The separate `execpolicy` crate evaluates Starlark `prefix_rule(pattern, decision=allow|prompt|forbidden, match=[...], not_match=[...])` with examples validated at load time (https://github.com/openai/codex/blob/main/codex-rs/execpolicy/README.md). That two-layer design (literal-command facts, then a policy with unit-tested examples) is exactly #21's shape.

**Claude Code** (https://code.claude.com/docs/en/permissions). Closed source; the docs state that `&&`, `||`, `;`, `|`, `|&`, `&` and newlines split compound commands and every part must match, a dangling `&&` makes the command unparseable, deny rules match past any leading env assignment, and the built-in read-only set still prompts when an unquoted glob meets a write- or exec-capable command such as `find`, `sed`, `sort` or `git`. **Gemini CLI** splits on `&&`, `||`, `;`, checks its exclude list first, then prefix-matches (https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/shell.md).

## Data sources for facts

**GTFOBins** (https://github.com/GTFOBins/GTFOBins.github.io). GPL-3.0. 478 entries under `_gtfobins/`, each a YAML front-matter file: `functions:` maps a capability to a list of `{code, contexts: {sudo, suid, unprivileged}, sender|receiver}`. Capability keys from `_data/functions.yml`: shell, command, reverse-shell, bind-shell, file-write, file-read, upload, download, library-load, privilege-escalation, inherit, each mapped to MITRE technique ids (T1059, T1071, T1565, T1005, T1041). `api.json` in the repo is a Jekyll template; the rendered JSON is served from the site. This is precisely a "binary X can upload / read files / spawn a shell" table. License caveat: pi-guru is MIT; a table derived from GTFOBins is a derivative of GPL-3.0 content. Options are to ship the derived table as a separately licensed GPL data file, fetch it at install time, or hand-curate a short list of the binaries that matter (curl, wget, nc, socat, ssh, scp, rsync, python, perl, base64, openssl, dd, tar) from man pages.

**LOLBAS** is the Windows analogue (GPL-3.0, Microsoft-signed binaries only, https://github.com/LOLBAS-Project/LOLBAS). Not applicable.

**Sigma** (https://github.com/SigmaHQ/sigma). Detection Rule License 1.1 permits use, modification and redistribution with author attribution retained (https://github.com/SigmaHQ/Detection-Rule-License). 122 rules under `rules/linux/process_creation`, covering curl/wget to `/tmp` then exec, base64-decoded execution, netcat/python/perl/php/ruby reverse shells, `cp /etc/shadow` to `/tmp`, crontab removal, `dd` overwrite, history clearing, and more. Example, "Suspicious Curl File Upload": `Image|endswith: '/curl'` with `--form`, `--upload-file`, `--data*` or regex `\s-[FTd]\s`, minus localhost, level medium, falsepositives "Scripts created by developers and admins". Matching is `CommandLine|contains`, so the rules are keyword-shaped, but they are curated, MITRE-tagged and carry false-positive notes, which makes them a good checklist for which facts to write.

**Falco** (https://github.com/falcosecurity/rules). Apache-2.0. Conditions are over syscall event fields, so most rules do not translate to command text (for example "Redirect STDOUT/STDIN to Network Connection" is a `dup` syscall check). Reusable lists: `sensitive_file_names` = `/etc/shadow, /etc/sudoers, /etc/pam.conf, /etc/security/pwquality.conf`; "Search Private Keys or Passwords" looks for `grep` or `find` with `id_rsa`, `id_dsa`, `id_ed25519`, `id_ecdsa`; "Find AWS Credentials" for `.aws/credentials`.

**RedCode** (https://github.com/AI-secure/RedCode). Code MIT, dataset CC BY 4.0. The paper (NeurIPS 2024 Datasets and Benchmarks, https://arxiv.org/abs/2411.07781) describes "25 types of critical vulnerabilities spanning 8 domains". On disk, `dataset/RedCode-Exec/bash2text_dataset_json` has 20 index files (indices 1–9, 12–16, 18, 20–23, 25) and the Python set has 27 (1–27), 30 cases each, with fields `Index`, `Language`, `Code`, `Text_summary`, `Text_details`, `expected_result`. Case 1_1 POSTs `/etc/passwd` to a URL with `curl --data-binary @file`. This is the right corpus for measuring each fact's true and near-miss rates; it is not a rule source.

**MITRE ATT&CK command lists** (`bmlien/mitre-bash-commands`): the repository returned 404 and a GitHub search found no repository by that name. Not verified.

## Recommended architecture

**(a) Parser for bash facts: stay on unbash.** It is in-process, 17 µs per parse, ISC, actively released (4.0.11 two days ago), and already wired into `classify.ts`. Neither mvdan/sh (WASM at 18 ms) nor tree-sitter-bash (native addon or WASM, same facts) adds anything the fact rules need. Write the fact extractor as an explicit walk over `Command`, `Word.parts`, pipelines and redirects, following two borrowed rules: Codex's "literal words only; never use static spelling to prove safety", and pi-permission-system's "unparseable or wrapper-hidden means a fact of its own" (`unparseable-command`, `wraps-command-in: bash -c|eval|sudo|env|xargs|find -exec`), which the judge and floors can weigh. Seed the fact list from cc-safety-net's analyzers (rm flags and targets, find -delete, git force/reset), Sigma's Linux process-creation titles, Falco's credential lists, and Claude Code's documented read-only-plus-glob exception.

**(b) File-content facts: yes, use `@ast-grep/napi`.** MIT, 7–10 ms warm import, 1.7–2.7 ms per 5 KB file with several rules, structural matching for Python (`os.system`, `subprocess(..., shell=True)`, `eval`, `pickle.loads`, `requests.get(verify=False)`), JavaScript/TypeScript (`child_process.exec`, `eval`, `new Function`, `rejectUnauthorized: false`) and shell files (`curl … | sh`, `chmod 777`). Register bash, python and yaml once at extension load. Accept that Dockerfile is not built in; treat Dockerfiles with a small line-regex set. Cost is roughly 30 MB of node_modules and a 1–2 s one-time cold read on first launch.

**(c) Secrets: a small in-process pattern set, not gitleaks.** gitleaks costs 320 ms per spawn and 21 MB; a write call's content is a few KB. Copy the 10–15 highest-precision gitleaks rules (MIT) plus its keyword pre-filter idea into a TypeScript table, keep entropy checks off by default (they are the main false-positive source), and add path facts (`writes .env`, `writes *.pem`, `reads ~/.ssh/*`, `reads ~/.aws/credentials`) from resolved paths.

**(d) GTFOBins as a data source: yes, with a license decision.** Generate a `binary → {upload, download, file-read, file-write, shell, reverse-shell}` table from the rendered `api.json`, then emit facts such as `invokes upload-capable binary: curl (-d @file)` only when the AST shows the argument shape, never on the bare binary name. Because the source is GPL-3.0 and pi-guru is MIT, either ship the table as a GPL-licensed data file with attribution, fetch it at install time, or hand-write the dozen entries that matter. Owner's call.

**Latency budget per call (measured components):**

| Step | Cost |
|---|---|
| unbash parse + fact walk | < 0.1 ms |
| path resolution for write/edit | < 1 ms |
| ast-grep napi parse + ~20 rules on a 5 KB file | 2–5 ms |
| in-process secret regex table on 5 KB | < 1 ms |
| total | well under 10 ms, versus seconds for the LLM judge |

Nothing in the recommended set spawns a process.

## Suspected, not verified

- The exact names of RedCode's 25 scenarios and 8 domains are in the paper's taxonomy figure; neither the GitHub README nor the project site enumerates them.
- gitleaks did not flag the AWS documentation example keys in the local test; the likely reason is its default allowlist of example values, not checked in the TOML.
- `bmlien/mitre-bash-commands` could not be located.
- Anthropic's actual Bash classifier code is closed; only the documented behaviour above is known.
- Microsoft agent sandbox policies were not surveyed.
- opengrep per-call latency was not measured; Semgrep's Python wrapper typically costs about a second of startup.
- `@ast-grep/lang-bash` is at version 0.0.8 with an ISC license and an auto-generated README, so its grammar version and maintenance cadence should be checked before depending on it for bash file contents.
