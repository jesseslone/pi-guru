/**
 * Stop handoff: the note pi-guru leaves when it blocks a change call with no person
 * present — what was attempted, why it was stopped, and what a person should do next
 * (CONTEXT.md). Written so unattended work never ends silently.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface HandoffDetails {
	/** The tool that was blocked (e.g. `bash`, `write`). */
	toolName: string;
	/** A one-line description of the attempted change call (command or path + preview). */
	attempted: string;
	/** Why it was stopped. */
	reason: string;
}

export interface WrittenHandoff {
	path: string;
	contents: string;
}

/** Filesystem-safe timestamp: ISO 8601 with `:` replaced (colons break some tools/FS). */
export function handoffTimestamp(date = new Date()): string {
	return date.toISOString().replace(/:/g, "-");
}

/**
 * Write a stop handoff to `.pi/handoffs/<ISO timestamp>-pi-guru.md` under `cwd`.
 * Returns the absolute path and the contents written.
 */
export function writeHandoff(cwd: string, details: HandoffDetails, date = new Date()): WrittenHandoff {
	const dir = join(cwd, ".pi", "handoffs");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${handoffTimestamp(date)}-pi-guru.md`);
	const contents = renderHandoff(details, date);
	writeFileSync(path, contents, "utf8");
	return { path, contents };
}

/** Render the handoff markdown. Kept separate so tests can assert on the contents. */
export function renderHandoff(details: HandoffDetails, date = new Date()): string {
	return `# pi-guru stop handoff

pi-guru paused a change because no one was here to review it at the gate.

- **When:** ${date.toISOString()}
- **Tool:** ${details.toolName}
- **What was attempted:** ${details.attempted}
- **Why it was stopped:** ${details.reason}

## What to do next

1. Review the attempted change call above and decide whether it should run.
2. If it is safe, run pi interactively (\`pi\`) and let the agent retry, approving it
   at the gate — or approve it for the session.
3. If it is not safe, tell the agent what to do differently, or leave a session allow
   for the commands you trust with \`/gate\`.

_This note was written by pi-guru. It is not sent to the model._
`;
}
