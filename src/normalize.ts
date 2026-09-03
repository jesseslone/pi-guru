/**
 * Turn a change-call tool input into the `NormalizedCall` the pipeline consumes:
 * the hard-deny subject, the session-allow key, and the gate display. Kept separate
 * from the pi event wiring so the mapping is unit-testable.
 */

import { extractCommandWords } from "./classify.ts";
import type { NormalizedCall } from "./pipeline.ts";

/** Max characters of write content / edit preview shown at the gate. */
const PREVIEW_LIMIT = 400;

export function normalizeBash(command: string): NormalizedCall {
	return {
		toolName: "bash",
		kind: "bash",
		command,
		words: extractCommandWords(command),
		title: "Run this command?",
		detail: command,
	};
}

export function normalizeWrite(path: string, content: string): NormalizedCall {
	return {
		toolName: "write",
		kind: "write",
		filePath: path,
		// Full, unclipped content for the assessor's content/secret scan.
		content,
		title: "Write this file?",
		detail: `${path}\n\n${clip(content)}`,
	};
}

export function normalizeEdit(path: string, edits: { oldText: string; newText: string }[]): NormalizedCall {
	const diff = edits.map((e) => `- ${firstLine(e.oldText)}\n+ ${firstLine(e.newText)}`).join("\n");
	return {
		toolName: "edit",
		kind: "edit",
		filePath: path,
		// The assessor scans the text being introduced — the new side of every edit.
		content: edits.map((e) => e.newText).join("\n"),
		title: "Edit this file?",
		detail: `${path}\n\n${clip(diff)}`,
	};
}

/** Any tool not known to be read-only and not bash/write/edit — always gated, never allow-matched. */
export function normalizeOther(toolName: string, input: unknown): NormalizedCall {
	return {
		toolName,
		kind: "other",
		title: "Allow this tool to run?",
		detail: `${toolName}: ${clip(safeJson(input))}`,
	};
}

function clip(s: string): string {
	return s.length > PREVIEW_LIMIT ? `${s.slice(0, PREVIEW_LIMIT)}…` : s;
}

function firstLine(s: string): string {
	const nl = s.indexOf("\n");
	return nl === -1 ? s : `${s.slice(0, nl)}…`;
}

function safeJson(input: unknown): string {
	try {
		return JSON.stringify(input);
	} catch {
		return String(input);
	}
}
