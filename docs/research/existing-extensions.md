# Web research: pi-coding-agent permission / guard / AI-approval extensions

Status: started 2026-09-02. Findings appended as found.

## Candidates

(none yet)

## Design references

(none yet)

## Checkpoint 1 (raw discovery, 2026-09-02)
npm + gh topic search surfaced these candidates (details to follow):
- @gotgenes/pi-permission-system v30.1.0 MIT, repo gotgenes/pi-packages (packages/pi-permission-system), updated 2026-09-02 — (a)
- pi-permission-system v0.8.0 MIT, repo MasuRii/pi-permission-system, updated 2026-07-03 — (a) (earlier/original of the gotgenes one?)
- @shinynito/pi-menshen v2.1.0, repo ShinyNito/pi-menshen, updated 2026-08-11 — "permission gate with auto-review mode (tree-sitter bash parsing)" (a, maybe c)
- @xynogen/pix-gate v0.2.11 MIT, repo xynogen/pix-mono, updated 2026-08-27 — dangerous bash confirm/block dialog (a); @dihak/pix-gate v0.1.15 is an older fork/prior name (2026-07-21)
- @erichll/pi-auto-review v0.15.2 MIT, repo erichll/pi-packages (packages/pi-auto-review), updated 2026-09-02 — "fail-closed, model-backed approval broker... reviewer model... one-shot expiring grants for OS sandbox adapters" (c)
- czottmann/pi-automode MIT, updated 2026-09-02 — "Think Claude Code's auto mode but for pi (and oh-my-pi). Selectable model" (c)
- carderne/pi-sandbox MIT, updated 2026-09-02 — OS-level sandboxing with interactive permission prompts (a)
- cjermain/pi-less-yolo Apache-2.0, 2026-08-31 — Docker sandbox wrapper (adjacent)
- kenryu42/cc-safety-net MIT, 2026-09-02 — cross-agent pre-execution guard, deterministic block of destructive git/fs, supports Pi (a, block-only)
- tintinweb/pi-supervisor MIT — goal-steering supervisor, not a gate (adjacent)
- Directories: qualisero/awesome-pi-agent, shaftoe/awesome-pi-coding-agent (auto-curated daily)
Nothing yet matching (b) "explain this command" on the prompt.

## Checkpoint 2 (READMEs read, 2026-09-02)

### Pi hook API (from badlogic/pi-mono packages/coding-agent/docs/extensions.md)
- `pi.on("tool_call", async (event, ctx) => ...)` fires before every tool; return `{ block: true, reason?: string, terminate?: boolean }` to block. Handlers chain; errors in tool_call block the tool (fail-safe). `event.toolName`, `event.input`.
- UI: `ctx.hasUI`, `ctx.ui.confirm(title, msg, {timeout|signal})`, `ctx.ui.select(msg, options, {timeout})`, `ctx.ui.input`, `ctx.ui.custom()` for full TUI components. `ui_prompt_*` lifecycle events fire around these.
- Official examples: examples/extensions/permission-gate.ts (regex rm -rf/sudo/chmod 777 -> ctx.ui.select Yes/No; blocks when !ctx.hasUI), protected-paths.ts, project-trust.ts, timed-confirm.ts, sandbox/, gondolin/. 
- Extension docs list: "permission-gate.ts | Block dangerous commands | on('tool_call'), ui.confirm".

### Candidate detail
1. czottmann/pi-automode (npm @czottmann/pi-automode, MIT, updated 2026-09-02) — (c) primarily, (a) via permissions.allow/ask/deny rules. "Claude Code-style auto mode for Pi." Pipeline: permissions.deny -> deterministic hard-denies (shell profile/authorized_keys/cron/TLS weakening/root+home deletes/edits to its own config) -> permissions.allow -> read-only tool allow -> classifier (one-token filter then structured review, dedicated session key, fail-closed on missing model/parse error). Bash parsed with `unbash`. Selectable classifier model (/automode model). Status line AM● a:12 d:2 ca:5 cd:1. Commands /automode on|off|status|reload|denials|model. Supports OMP. Config ~/.pi/agent/extensions/pi-automode/config.json + .pi/automode.local.json. Explicitly says CC's real classifier prompt is private, they implement documented precedence. Blocks only, no interactive approve dialog surfaced in README ("declined ask matches" implies ask prompt exists).
2. ShinyNito/pi-menshen (npm @shinynito/pi-menshen v2.1.0, license not declared in npm, updated 2026-08-11) — (a)+(c). Rule engine Tool(content) allow/deny/ask like CC syntax; tree-sitter bash parsing (fail-closed); ~200-entry read-only command registry fast path; Guardian-style reviewer = a real pi agent session with read-only tools, reused as trunk with delta transcript; strict JSON {risk_level,user_authorization,outcome,rationale}; circuit breaker 3 consecutive/10-in-50; reviewer deny fed back to agent as tool error; manual dialog only when reviewer can't decide: Allow once / Deny / Deny & remember / Deny with reason. Dialog shows Guardian risk badge + rationale (closest thing to (b) found so far, but it's the reviewer's rationale not a user-requested explanation). Subagent confirm relay via globalThis bus. OSC terminal notifications. Config ~/.pi/pi-menshen.json. /perm commands.
3. gotgenes/pi-packages -> @gotgenes/pi-permission-system (v30.1.0, MIT, updated 2026-09-02; fork of MasuRii/pi-permission-system) — (a) deterministic, no LLM in core. allow/ask/deny across tool/bash/mcp/skill/path/external_directory surfaces; wildcard bash rules, last-match-wins; hides disallowed tools from model; fails closed on unparseable bash; wrapper detection (bash -c/eval/sudo/env/xargs); symlink-resolved path matching; directional read/write; project config gated on project trust; inline keybind dialog y/s/n/r (approve once / session / deny / deny with reason), Ctrl+O expand; subagent ask forwarding; `permissions:ui_prompt` and `permissions:decision` events on pi bus; `authorizerChain` seam: `getPermissionsService(sessionId).registerAuthorizer(name, fn)` lets a downstream ext judge `ask` cases before the human prompt (c via plug-in). First-party link: @gotgenes/pi-permission-model-judge (deny-first, judges mistyped out-of-dir paths). README explicitly lists "risk explanations" as out-of-scope/downstream ("Approve-and-steer, edit diffs, and risk explanations -> a downstream package over the permissions:decision event") => (b) is an acknowledged gap here.
4. erichll/pi-packages -> @erichll/pi-auto-review (v0.15.2, MIT, updated 2026-09-02) — (c). Authorizer link for @gotgenes/pi-permission-system (28.x/29.x). Order: deterministic hard denies -> bounded model review (default model "codex-auto-review", reasoning low, 256 max tokens, 90s deadline, fail closed) -> local human prompt when required -> one-shot expiring grant consumed by OS sandbox adapters (process-local broker Symbol.for("pi-auto-review:boundary-approval-broker")). Circuit breaker same 3/10-of-50. /auto-review-approve (exact retry of non-critical denial), /auto-review-break-glass (typed BREAK-GLASS code). TUI widget shows outcome+rationale+tokens. SQLite policy audit. Project config tighten-only.
5. xynogen/pix-mono -> @xynogen/pix-gate (v0.2.11, MIT, updated 2026-08-27; @dihak/pix-gate is prior alias) — (a). Severity tiers critical/dangerous/risky with timed auto-deny/auto-allow dialogs; path rules block/warn/info; sudo redirected to sudo_run tool; /afk and /yolo modes via pix-commands; circuit breaker floor that even yolo can't bypass (mirrors CC bypassPermissions floor). Pure rule lib export @xynogen/pix-gate/lib. Config ~/.pi/agent/pix.json.
6. carderne/pi-sandbox (npm pi-sandbox, MIT, updated 2026-09-02) — (a) via OS sandbox: read/write/edit allow/deny lists; bash wrapped in sandbox-exec/bubblewrap via @carderne/sandbox-runtime (fork of anthropic-experimental/sandbox-runtime); blocked actions prompt "allow temporarily or permanently"; Alt+S toggle; /sandbox-allow domain|read|write; permissionPromptTimeoutSeconds.
7. MasuRii/pi-permission-system (npm pi-permission-system v0.8.0, MIT, updated 2026-07-03) — (a) upstream of #3, less maintained.
8. pi-guard family (all (a)-ish, small): jdiamond/pi-guard (npm pi-guard 1.4.0, MIT, 2026-07-11, "general-purpose permission system for pi tools, bash + file tools, extensible matchers"); @tylerho/pi-guard 0.1.0 (2026-08-22, confirm before risky git writes/PR publish/recursive rm); @shelken/pi-guard 0.6.0 (hard-block bash + secret paths, 2026-07-29); @lystran/pi-guard 0.2.0 (configurable command guard rules, 2026-08-24); @heathhe/pi-guard 0.1.0 (session-scoped guard modes + OS-sandboxed bash, 2026-08-05); pi-guard-sandbox 0.3.0 (RunMintOn, OS-level, 2026-07-22); @jonstuebe/pi-guard 0.1.0 (Gondolin sandbox, Apache-2.0, 2026-08-16); pi-process-guard 2.0.2 (skeleton).
9. kenryu42/cc-safety-net (MIT, 2026-09-02) — cross-agent (Claude Code, Codex, Pi, ...) pre-execution guard; deterministic block of destructive git/fs + sensitive file access; no prompt, no LLM. (a: block-only)
10. cjermain/pi-less-yolo (Apache-2.0, 2026-08-31) — Docker container sandbox wrapper, not a prompt.

### Claude Code auto mode (design reference, code.claude.com/docs/en/permission-modes.md)
- "A separate classifier model reviews actions before they run, blocking anything that escalates beyond your request, targets unrecognized infrastructure, or appears driven by hostile content Claude read. Explicit ask rules still force a prompt." Also reviews SendMessage to other agents; reviews rm/rmdir of critical paths (/ and ~). Bash prompt gains "Yes, and switch to auto mode". Shift+Tab cycles modes. Needs supported model; org can disable via permissions.disableAutoMode.

## Checkpoint 3 (final, 2026-09-02)

### Context fact
Pi core has NO tool-call approval feature. pi.dev/docs usage page: "intentionally does not include ... permission popups". Armin Ronacher (co-maintainer) article "Pi's New Approval System" (x.com/mitsuhiko, 2026-06-08): "Pi does not have a command approval feature, so what it runs, it runs" — the only built-in prompt is the once-per-project *project trust* prompt (`project_trust` event, `-a/--approve`), added because of infected AGENTS.md/.pi/extensions in untrusted repos. Repo has moved: badlogic/pi-mono -> earendil-works/pi. Everything below is an extension hooking `pi.on("tool_call")` and returning `{block, reason}`.

### Additional candidates found late
- mcollina/pi-bash-confirm (npm pi-bash-confirm, MIT, updated 2026-09-02, requires pi 0.80.x) — (a)+(c). Dialog: Approve / Edit command in pi editor / Always Accept (Exact) / Always Accept (Generic regex) / Block; per-project whitelist .pi/bash-confirm-whitelist.json; safeCommands/blockedCommands regex; optional autoAccept with configurable fast model (strictness permissive/..., timeout 5s, late allow dismisses dialog); Telegram notifications; blocks when no UI. Has a `debug` flag that shows why a command was allowed/blocked (not an LLM explanation).
- @agentapprove/pi v0.1.13 (proprietary license, 2026-08-31) — approve/deny tool calls from iPhone/Apple Watch; privacy modes minimal/summary/full.
- @cad0p/pi-steering v0.2.0 MIT 2026-09-01 — AST-backed deterministic tool-call guardrails with effective-cwd scoping (a, block-only).
- @piagent/platform v1.6.1 MIT 2026-08-26 (Vt-mmm/piagent) — guardrails: blocks secret reads, destructive commands, unapproved MCP servers (a, block-only).
- @wernerbisschoff/pi-gatekeeper v0.1.12 (2026-07-08) — permission enforcement for Pi/OMP (a).
- @trim21/personal-pi-extensions — bwrap sandbox + workspace guard (a).
- jdiamond/pi-guard (npm pi-guard 1.4.0, MIT, 2026-07-11) — AST-parsed bash, per-subcommand ✔/✖ display, Allow / Always allow <cmd> this session / Reject; layered config; PI_GUARD env for CI. (a)
- @tylerho/pi-guard 0.1.0 — git/pr/rm guards via ctx.ui.confirm, subagent prompt bridging to parent UI. (a)

### (b) explain-option: NOT FOUND
Searched npm, gh code, gh repos, awesome lists (shaftoe 1.8MB auto-curated), web search. No pi extension offers an "Explain this command" choice on the approval prompt that calls the LLM for a plain-language description. Nearest: pi-menshen shows the reviewer's rationale + risk badge on the manual dialog; pi-auto-review shows outcome+rationale in a widget; pi-bash-confirm `debug` shows rule-match reason; gotgenes README explicitly lists "risk explanations" as a downstream package to be built over its `permissions:decision` event. pi-bro explains pasted text generally but is not tied to permissions.
