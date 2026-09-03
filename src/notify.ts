/**
 * `notify` — a `ctx.ui.notify` that does not vanish without a UI.
 *
 * `ctx.ui.notify` is a no-op when there is no TUI, so a rejected option (e.g. `--passes 2`) or a
 * model-resolution error produces nothing under `pi -p`. This helper still speaks through the UI,
 * and — where the notify would be lost (no UI, or print/json mode) — also writes the message to a
 * standard stream so a person running non-interactively sees it: info/warning to stdout, error to
 * stderr, prefixed exactly as the message already is. In TUI and RPC it is `ctx.ui.notify` only.
 */

/** Notify severities, matching `ctx.ui.notify`'s second argument. */
export type NotifyType = "info" | "warning" | "error";

/** The slice of the extension context `notify` reads — small enough for tests to fake. */
export interface NotifyContext {
	hasUI: boolean;
	mode: "tui" | "rpc" | "json" | "print";
	ui: { notify: (message: string, type?: NotifyType) => void };
}

/**
 * Show `message` via the UI; when the UI would swallow it (no UI, or print/json mode) also write it
 * to stdout (info/warning) or stderr (error). The message is written verbatim — callers keep their
 * `pi-guru:` / `pi-guru-bench:` prefix.
 */
export function notify(ctx: NotifyContext, message: string, type: NotifyType = "info"): void {
	ctx.ui.notify(message, type);
	// TUI (hasUI, mode "tui") and RPC (hasUI, mode "rpc") render the notify — nothing more to do.
	if (ctx.hasUI && ctx.mode !== "print" && ctx.mode !== "json") return;
	const stream = type === "error" ? process.stderr : process.stdout;
	stream.write(`${message}\n`);
}
