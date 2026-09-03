# pi-coding-agent v0.84.2 Extension API — Reference for a Permission-Gate Plugin

Package root (abbreviated below as `PKG`):
the installed `@earendil-works/pi-coding-agent` package (`node_modules/@earendil-works/pi-coding-agent/`)

---

## 1. Intercepting a tool call before it executes

**Event: `tool_call`.** Fires after `tool_execution_start`, before the tool runs.

Handler registration signature — `PKG/dist/core/extensions/types.d.ts:897`:

```ts
on(event: "tool_call", handler: ExtensionHandler<ToolCallEvent, ToolCallEventResult>): void;
```

### Event shape

`PKG/dist/core/extensions/types.d.ts:649-691`:

```ts
interface ToolCallEventBase {
  type: "tool_call";
  toolCallId: string;
}
export interface BashToolCallEvent  extends ToolCallEventBase { toolName: "bash";  input: BashToolInput; }
export interface ReadToolCallEvent  extends ToolCallEventBase { toolName: "read";  input: ReadToolInput; }
export interface EditToolCallEvent  extends ToolCallEventBase { toolName: "edit";  input: EditToolInput; }
export interface WriteToolCallEvent extends ToolCallEventBase { toolName: "write"; input: WriteToolInput; }
export interface GrepToolCallEvent  extends ToolCallEventBase { toolName: "grep";  input: GrepToolInput; }
export interface FindToolCallEvent  extends ToolCallEventBase { toolName: "find";  input: FindToolInput; }
export interface LsToolCallEvent    extends ToolCallEventBase { toolName: "ls";    input: LsToolInput; }
export interface CustomToolCallEvent extends ToolCallEventBase {
  toolName: string;
  input: Record<string, unknown>;
}
export type ToolCallEvent = BashToolCallEvent | ReadToolCallEvent | EditToolCallEvent
  | WriteToolCallEvent | GrepToolCallEvent | FindToolCallEvent | LsToolCallEvent | CustomToolCallEvent;
```

### Blocking

Return value — `PKG/dist/core/extensions/types.d.ts:779-788`:

```ts
export interface ToolCallEventResult {
  /** Block tool execution. To modify arguments, mutate `event.input` in place instead. */
  block?: boolean;
  reason?: string;
  /**
   * Hint that the agent should stop after the current tool batch when this call is blocked.
   * Early termination only happens when every finalized tool result in the batch sets this to true.
   */
  terminate?: boolean;
}
```

Return `undefined` to allow.

### Modifying

`event.input` is mutable — mutate it in place. Documented guarantees at `PKG/docs/extensions.md:759-766`:

- Mutations to `event.input` affect actual tool execution.
- Later `tool_call` handlers see mutations made by earlier handlers.
- **No re-validation is performed after your mutation.**

### Canonical snippet

`PKG/docs/extensions.md:769-791`:

```ts
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

pi.on("tool_call", async (event, ctx) => {
  // event.toolName, event.toolCallId, event.input (mutable)

  if (isToolCallEventType("bash", event)) {
    // event.input is { command: string; timeout?: number }
    event.input.command = `source ~/.profile\n${event.input.command}`;

    if (event.input.command.includes("rm -rf")) {
      return { block: true, reason: "Dangerous command", terminate: true };
    }
  }

  if (isToolCallEventType("read", event)) {
    // event.input is { path: string; offset?: number; limit?: number }
  }
});
```

Custom tools need explicit type params:
`isToolCallEventType<"my_tool", MyToolInput>("my_tool", event)` — `PKG/docs/extensions.md:802-813`.

### Working examples

- `PKG/examples/extensions/permission-gate.ts:13-33` — bash regex gate + `ui.select`
- `PKG/examples/extensions/protected-paths.ts:13-29` — blocks `write`/`edit` to `.env`, `.git/`, `node_modules/`

### Related events

- `tool_result` — modify output after execution (`PKG/docs/extensions.md:815-848`); returns `{ content?, details?, isError?, usage? }` (`types.d.ts:796-801`)
- `user_bash` — intercept user `!` / `!!` commands (`PKG/docs/extensions.md:850-880`)

### Ordering caveat

In default parallel tool mode, sibling tool calls from one assistant message are **preflighted sequentially, then executed concurrently** (`PKG/docs/extensions.md:757`). Your gate sees siblings one at a time but not their results.

---

## 2. Interactive prompts with custom buttons/choices

### Dialog API

`PKG/dist/core/extensions/types.d.ts:68-78` (interface `ExtensionUIContext`):

```ts
select(title: string, options: string[], opts?: ExtensionUIDialogOptions): Promise<string | undefined>;
confirm(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean>;
input(title: string, placeholder?: string, opts?: ExtensionUIDialogOptions): Promise<string | undefined>;
editor(title: string, prefill?: string): Promise<string | undefined>;
notify(message: string, type?: "info" | "warning" | "error"): void;
```

Options type — `PKG/dist/core/extensions/types.d.ts:35-40`:

```ts
export interface ExtensionUIDialogOptions {
  signal?: AbortSignal;   // programmatically dismiss
  timeout?: number;       // ms; auto-dismiss with live countdown in the title
}
```

### Approve / Deny / Explain

`select` handles this directly:

```ts
const choice = await ctx.ui.select(
  `Allow this command?\n\n  ${cmd}`,
  ["Approve", "Deny", "Explain"],
);
if (choice !== "Approve") return { block: true, reason: "Blocked by user" };
```

### Default choice — NOT supported by `select`

There is no `default`/`initialIndex` option. `ExtensionUIDialogOptions` has only `signal` and `timeout`.

Timeout return values (`PKG/docs/extensions.md:2521-2524`):

| Method | Returns on timeout |
|---|---|
| `select()` | `undefined` |
| `confirm()` | `false` |
| `input()` | `undefined` |

**To get a preselected default**, build the picker with `ctx.ui.custom()` and a `SelectList`, which exposes `setSelectedIndex(index)` — `PKG/node_modules/@earendil-works/pi-tui/dist/components/select-list.d.ts:37`:

```ts
export declare class SelectList implements Component {
  onSelect?: (item: SelectItem) => void;
  onCancel?: () => void;
  onSelectionChange?: (item: SelectItem) => void;
  constructor(items: SelectItem[], maxVisible: number, theme: SelectListTheme, layout?: SelectListLayoutOptions);
  setFilter(filter: string): void;
  setSelectedIndex(index: number): void;   // <-- default choice
  getSelectedItem(): SelectItem | null;
}
export interface SelectItem { value: string; label: string; description?: string; }
```

Copy-paste pattern (SelectList + DynamicBorder inside `ctx.ui.custom`) at `PKG/docs/tui.md:612-668`. Live examples: `PKG/examples/extensions/preset.ts`, `PKG/examples/extensions/tools.ts`.

### `ctx.ui.custom()` signature

`PKG/dist/core/extensions/types.d.ts:119-131`:

```ts
custom<T>(
  factory: (tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: (result: T) => void)
    => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
  options?: {
    overlay?: boolean;
    overlayOptions?: OverlayOptions | (() => OverlayOptions);
    onHandle?: (handle: OverlayHandle) => void;
  }
): Promise<T>;
```

Guard with `ctx.mode === "tui"` — `custom()` is terminal-only. Overlay mode docs at `PKG/docs/extensions.md:2733-2765`.

### Mode guards

Always check `ctx.hasUI` before any dialog and pick a fail-safe default, as `PKG/examples/extensions/permission-gate.ts:20-23` does:

```ts
if (!ctx.hasUI) {
  return { block: true, reason: "Dangerous command blocked (no UI for confirmation)" };
}
```

`hasUI` is `true` in TUI and RPC, `false` in print (`-p`) and JSON modes (`PKG/docs/extensions.md:945-947`).

---

## 3. LLM call from inside a `tool_call` hook

**Yes.** Use `ctx.modelRegistry.complete()`.

Signature — `PKG/dist/core/model-registry.d.ts:33`:

```ts
complete<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: ModelsApiStreamOptions<TApi>
): Promise<AssistantMessage>;
```

Full `ModelRegistry` surface — `PKG/dist/core/model-registry.d.ts:20-42`:

```ts
getAll(): Model<Api>[];
getAvailable(): Model<Api>[];
find(provider: string, modelId: string): Model<Api> | undefined;
hasConfiguredAuth(model: Model<Api>): boolean;
getApiKeyAndHeaders(model: Model<Api>): Promise<ResolvedRequestAuth>;
getProvider(provider: string): Provider | undefined;
getProviderAuth(provider: string): Promise<AuthResult | undefined>;
complete<TApi>(model, context, options?): Promise<AssistantMessage>;
registerProvider(...); unregisterProvider(...);
```

### Different system prompt

`Context` carries its own system prompt — `PKG/node_modules/@earendil-works/pi-ai/dist/types.d.ts:377-381`:

```ts
export interface Context {
  systemPrompt?: string;
  messages: Message[];
  tools?: Tool[];
}
```

So a different system prompt is just a field on the context you pass. It does **not** touch the agent's own prompt.

### Abort support

`ModelsApiStreamOptions` extends `ApiStreamOptions` → `ProviderRequestOptions`, which has `signal?: AbortSignal`
— `PKG/node_modules/@earendil-works/pi-ai/dist/types.d.ts:49-50` and `PKG/node_modules/@earendil-works/pi-ai/dist/models.d.ts:45`.

Pass `ctx.signal` so Esc cancels the judge call. `ctx.signal` is defined during `tool_call` and `tool_result`, and usually `undefined` when idle (`PKG/docs/extensions.md:994-1000`).

### Getting the conversation messages

From `ctx.sessionManager` (read-only). Available methods — `PKG/dist/core/session-manager.d.ts:140`:

```ts
export type ReadonlySessionManager = Pick<SessionManager,
  "getCwd" | "getSessionDir" | "getSessionId" | "getSessionFile" | "getLeafId" |
  "getLeafEntry" | "getEntry" | "getLabel" | "getBranch" | "buildContextEntries" |
  "getHeader" | "getEntries" | "getTree" | "getSessionName">;
```

- `getBranch()` → `SessionEntry[]` for the current branch
- `buildContextEntries()` → active-branch entries **with compaction applied** — better input for a judge on long sessions
- `getEntries()` → all entries in the session tree

Freshness in `tool_call`: pi waits for prior agent events to drain, so `ctx.sessionManager` is up to date **through the current assistant tool-calling message** (`PKG/docs/extensions.md:755`). It is *not* guaranteed to include sibling tool results from that same assistant message.

Entries are raw `SessionEntry` objects, **not** provider `Message` objects. You must flatten them yourself.

### Full pattern

```ts
import { uuidv7 } from "@earendil-works/pi-ai";

pi.on("tool_call", async (event, ctx) => {
  const model = ctx.model ?? ctx.modelRegistry.find("anthropic", "claude-sonnet-5");
  if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) return;

  const transcript = buildConversationText(ctx.sessionManager.buildContextEntries());

  const verdict = await ctx.modelRegistry.complete(
    model,
    {
      systemPrompt: "You are a command safety judge. Reply APPROVE or DENY with one line of reasoning.",
      messages: [{
        role: "user" as const,
        content: [{ type: "text" as const, text: transcript }],
        timestamp: Date.now(),
      }],
    },
    { signal: ctx.signal, reasoningEffort: "low", cacheRetention: "none", sessionId: uuidv7() },
  );

  const text = verdict.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");

  if (text.startsWith("DENY")) return { block: true, reason: text };
});
```

### Reference implementation

`PKG/examples/extensions/summarize.ts` is the complete working version:

- `buildConversationText(entries)` at line 68 — flattens user/assistant text plus `toolCall` blocks into a transcript; directly reusable
- `extractTextParts` at line 21, `extractToolCallLines` at line 45
- model lookup + auth check at lines 163-171
- `ctx.modelRegistry.complete(...)` at line 181
- response text extraction at lines 191-194

Note also `PKG/docs/extensions.md:1986`: if a *tool* makes nested LLM calls, return the combined `Usage` as `usage` so pi accounts for it in the footer, `/session`, and RPC totals.

---

## 4. Built-in permission/approval mechanism

**There is none.** `PKG/docs/security.md:31-37` is explicit:

> Pi does not include a built-in sandbox. Built-in tools can read files, write files, edit files, and run shell commands with the permissions of the pi process. Extensions are TypeScript modules that run with the same permissions.
>
> Project trust is only an input-loading guard. It prevents a repository from silently changing pi's settings or extensions before you approve it. It does not make untrusted code, untrusted prompts, or untrusted model output safe.

**Project trust** (`PKG/docs/security.md:5-29`) gates loading of `.pi/settings.json`, `.pi/extensions`, `.pi/skills`, `.pi/prompts`, `.pi/themes`, `.pi/SYSTEM.md`, and project `.agents/skills`. Decisions are saved by canonical directory in `~/.pi/agent/trust.json`. Setting: `defaultProjectTrust` (`"ask"` default, also `"always"` / `"never"`). CLI overrides: `--approve`/`-a`, `--no-approve`/`-na`. Non-interactive modes never prompt. It does **not** gate tool execution.

Extensions can own the trust decision via the `project_trust` event; the first handler returning `{ trusted: "yes" | "no" }` wins, `{ trusted: "undecided" }` defers.

### Shipped guard/permission examples

All under `PKG/examples/extensions/`:

| File | What it does | Key APIs |
|---|---|---|
| `permission-gate.ts` | Regex-matches bash for `rm -rf`, `sudo`, `chmod/chown 777`; `ui.select` to allow; blocks when `!ctx.hasUI` | `on("tool_call")`, `ui.select` |
| `protected-paths.ts` | Blocks `write`/`edit` to `.env`, `.git/`, `node_modules/` | `on("tool_call")` |
| `confirm-destructive.ts` | Confirms session clear/switch/fork via `{ cancel: true }` | `on("session_before_switch")`, `on("session_before_fork")` |
| `dirty-repo-guard.ts` | Blocks session changes with uncommitted git changes | `on("session_before_*")`, `pi.exec` |
| `project-trust.ts` | Owns the `project_trust` decision from a user/global or CLI extension | `on("project_trust")`, `ProjectTrustEventResult` |
| `sandbox/index.ts` | Real OS sandboxing via `@anthropic-ai/sandbox-runtime` (sandbox-exec on macOS, bubblewrap on Linux); per-project `.pi/sandbox.json` with `network.allowedDomains`, `filesystem.denyRead`/`allowWrite`/`denyWrite`; overrides the built-in `bash` tool | `createBashTool`, `BashOperations`, `CONFIG_DIR_NAME`, `getAgentDir` |
| `gondolin/` | Routes built-in tools and `!` commands into a Gondolin micro-VM | tool operations, `on("user_bash")` |
| `bash-spawn-hook.ts` | Rewrites command, cwd, env before execution | `createBashTool({ spawnHook })`, `registerTool` |
| `timed-confirm.ts` | Dialogs with `timeout` and `AbortSignal` | `ui.confirm`, `ui.select` |

Index table: `PKG/docs/extensions.md:2929-2936`; README table: `PKG/examples/extensions/README.md:21-26`.

The sandbox example's own header note (`PKG/examples/extensions/sandbox/index.ts:7-10`) is relevant to design:

> this example intentionally overrides the built-in `bash` tool to show how built-in tools can be replaced. Alternatively, you could sandbox `bash` via `tool_call` input mutation without replacing the tool.

### Error handling

`PKG/docs/extensions.md:2894`: **`tool_call` errors block the tool (fail-safe).** A thrown exception in your gate blocks execution rather than allowing it.

---

## 5. Commands, keybindings, packaging, installation

### Commands

`PKG/docs/extensions.md:1498-1532`:

```ts
pi.registerCommand("review", {
  description: "Review a command",
  getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
    const envs = ["dev", "staging", "prod"].filter((e) => e.startsWith(prefix));
    return envs.length ? envs.map((e) => ({ value: e, label: e })) : null;
  },
  handler: async (args, ctx) => {
    // ctx is ExtensionCommandContext (extends ExtensionContext)
  },
});
```

Duplicate command names across extensions are all kept and get numeric suffixes in load order: `/review:1`, `/review:2`.

`pi.getCommands()` (`PKG/docs/extensions.md:1533-1564`) returns:

```ts
{
  name: string;                     // no leading slash; may be suffixed "review:1"
  description?: string;
  source: "extension" | "prompt" | "skill";
  sourceInfo: { path: string; source: string; scope: "user"|"project"|"temporary";
                origin: "package"|"top-level"; baseDir?: string };
}
```

### Keybindings

`PKG/docs/extensions.md:1611-1622`:

```ts
pi.registerShortcut("ctrl+shift+p", {
  description: "Toggle plan mode",
  handler: async (ctx) => { ctx.ui.notify("Toggled!"); },
});
```

Shortcut string format and built-in bindings: `PKG/docs/keybindings.md`.

### CLI flags

`PKG/docs/extensions.md:1624-1639`:

```ts
pi.registerFlag("plan", { description: "Start in plan mode", type: "boolean", default: false });
if (pi.getFlag("plan")) { /* ... */ }
```

### Discovery locations

`PKG/docs/extensions.md:109-125`:

| Location | Scope |
|---|---|
| `~/.pi/agent/extensions/*.ts` | Global |
| `~/.pi/agent/extensions/*/index.ts` | Global (subdirectory) |
| `.pi/extensions/*.ts` | Project-local (trust-gated) |
| `.pi/extensions/*/index.ts` | Project-local (trust-gated) |

Use the exported `CONFIG_DIR_NAME` constant rather than hardcoding `.pi` (`PKG/docs/extensions.md:951-964`).

### settings.json

`PKG/docs/extensions.md:117-127`:

```json
{
  "packages": ["npm:@foo/bar@1.0.0", "git:github.com/user/repo@v1"],
  "extensions": ["/path/to/local/extension.ts", "/path/to/local/extension/dir"]
}
```

User settings: `~/.pi/agent/settings.json`. Project settings: `.pi/settings.json` (`pi install -l`).

### Package manifest

`PKG/docs/packages.md:120-131`:

```json
{
  "name": "my-package",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

Paths are relative to package root; arrays support globs and `!exclusions`. Optional gallery metadata: `pi.video` (MP4), `pi.image` (PNG/JPEG/GIF/WebP).

Without a `pi` key, convention directories are auto-discovered (`PKG/docs/packages.md:156-163`): `extensions/` (`.ts`/`.js`), `skills/` (`SKILL.md` folders + top-level `.md`), `prompts/` (`.md`), `themes/` (`.json`).

### Dependencies

`PKG/docs/packages.md:165-176`:

- Runtime third-party deps → `dependencies` (pi runs `npm install --omit=dev`, so `devDependencies` are **not** available at runtime)
- Core pi packages → `peerDependencies` with `"*"`, never bundled: `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox`
- Other pi packages → `dependencies` + `bundledDependencies`, referenced via `node_modules/` paths

### Install / manage

`PKG/docs/packages.md:22-40`:

```bash
pi install npm:@foo/bar@1.0.0
pi install git:github.com/user/repo@v1
pi install /absolute/path/to/package
pi install ./relative/path/to/package
pi install -l ./pkg          # write to project settings instead of user settings

pi remove npm:@foo/bar
pi list
pi update --extensions       # update packages, reconcile pinned git refs

pi -e ./my-extension.ts      # try for one run, no install
pi -e npm:@foo/bar
```

### Available imports

`PKG/docs/extensions.md:139-152`:

| Package | Purpose |
|---|---|
| `@earendil-works/pi-coding-agent` | `ExtensionAPI`, `ExtensionContext`, event types, `defineTool`, `createBashTool`, `isToolCallEventType`, `CONFIG_DIR_NAME`, `DynamicBorder`, `BorderedLoader`, `CustomEditor` |
| `typebox` | Tool parameter schemas |
| `@earendil-works/pi-ai` | `uuidv7`, `StringEnum`, `Static`, `Type`, model types |
| `@earendil-works/pi-tui` | `Container`, `Text`, `Markdown`, `SelectList`, `SettingsList`, `matchesKey` |

Node built-ins (`node:fs`, `node:path`, …) are available. npm deps resolve from a `package.json` next to the extension or in a parent directory.

### Local reference packages


---

## 6. What the extension gets in `ctx`

### `ExtensionContext`

`PKG/dist/core/extensions/types.d.ts:209-249`:

```ts
export type ExtensionMode = "tui" | "rpc" | "json" | "print";

export interface ExtensionContext {
  ui: ExtensionUIContext;               // dialogs, widgets, status, custom components, theme
  mode: ExtensionMode;                  // guard terminal-only UI with mode === "tui"
  hasUI: boolean;                       // true in TUI and RPC; false in print (-p) and JSON
  cwd: string;
  sessionManager: ReadonlySessionManager;
  modelRegistry: ModelRegistry;
  model: Model<any> | undefined;        // active model
  scopedModels: readonly ScopedModel[]; // session-scoped model list (--models / enabledModels)
  thinkingLevel?: ThinkingLevel;
  isIdle(): boolean;
  isProjectTrusted(): boolean;
  signal: AbortSignal | undefined;      // agent abort signal; undefined when not streaming
  abort(): void;
  hasPendingMessages(): boolean;
  shutdown(): void;                     // graceful; deferred until idle
  getContextUsage(): ContextUsage | undefined;
  compact(options?: CompactOptions): void;
  getSystemPrompt(): string;
}
```

`ContextUsage` = `{ tokens: number | null; contextWindow: number; percent: number | null }` (`types.d.ts:200-207`).

### `ExtensionCommandContext` (command handlers only)

`PKG/dist/core/extensions/types.d.ts:254+`. Extends `ExtensionContext` with session-control methods that would deadlock if called from event handlers:

```ts
getSystemPromptOptions(): BuildSystemPromptOptions;
waitForIdle(): Promise<void>;
newSession(options?): Promise<{ cancelled: boolean }>;
fork(entryId, options?): Promise<{ cancelled: boolean }>;
navigateTree(targetId, options?): Promise<...>;
switchSession(sessionPath, options?): Promise<...>;
reload(): Promise<...>;
```

`getSystemPromptOptions()` may include full context-file contents — treat as sensitive; do not leak through logs or autocomplete metadata (`PKG/docs/extensions.md:1094-1097`).

### `ctx.ui` — full surface

`PKG/dist/core/extensions/types.d.ts:65-198`:

- Dialogs: `select`, `confirm`, `input`, `editor`, `notify`
- Custom UI: `custom<T>(factory, { overlay?, overlayOptions?, onHandle? })`
- Status/footer: `setStatus(key, text?)`, `setFooter(factory?)`, `setHeader(factory?)`, `setTitle(title)`
- Working loader: `setWorkingMessage(msg?)`, `setWorkingVisible(bool)`, `setWorkingIndicator({ frames?, intervalMs? })`, `setHiddenThinkingLabel(label?)`
- Widgets: `setWidget(key, content, { placement: "aboveEditor" | "belowEditor" })`
- Editor: `pasteToEditor`, `setEditorText`, `getEditorText`, `setEditorComponent(factory?)`, `getEditorComponent()`
- Autocomplete: `addAutocompleteProvider(factory)`
- Terminal: `onTerminalInput(handler) => unsubscribe`
- Theme: `readonly theme`, `getAllThemes()`, `getTheme(name)`, `setTheme(nameOrTheme)`
- Tools display: `getToolsExpanded()`, `setToolsExpanded(bool)`

### `ExtensionAPI` (`pi`) methods

`PKG/docs/extensions.md:1332-1849`:

`on`, `registerTool`, `sendMessage`, `sendUserMessage`, `appendEntry`, `setSessionName`, `getSessionName`, `setLabel`, `registerCommand`, `getCommands`, `registerMessageRenderer`, `registerMarkdownTransformer`, `registerEntryRenderer`, `registerShortcut`, `registerFlag`, `getFlag`, `exec(command, args, { signal, timeout })`, `getActiveTools`, `getAllTools`, `setActiveTools`, `setModel`, `getThinkingLevel`, `setThinkingLevel`, `events` (inter-extension event bus), `registerProvider`, `unregisterProvider`.

---

## Design notes for a permission-gate plugin

1. **Fail-safe is automatic.** A thrown error in `tool_call` blocks the tool (`PKG/docs/extensions.md:2894`). Explicitly block when `!ctx.hasUI`.
2. **Parallel tool mode.** Siblings preflight sequentially but execute concurrently. `terminate: true` only stops the agent when *every* finalized result in the batch sets it.
3. **No re-validation after mutation.** If you rewrite `event.input`, nothing checks the schema again.
4. **`ctx.signal` is live during `tool_call`.** Pass it to any LLM judge call or `fetch` so Esc cancels cleanly.
5. **Default choice needs `ctx.ui.custom` + `SelectList.setSelectedIndex`.** `ctx.ui.select` cannot preselect.
6. **Session state in `tool_call` is current through the assistant tool-calling message** but may lack sibling tool results.
