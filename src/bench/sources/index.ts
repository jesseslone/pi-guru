/**
 * The source registry. Order is stable for reproducible reports.
 *
 * Enabled by default: redcode-exec, rogue-security, local-manifest, hand-written.
 * Off by default (licence unconfirmed — plan finding 13): r-judge, control-arena-agentdojo.
 */

import type { Source } from "../schema.ts";
import { controlArenaAgentdojoSource } from "./control-arena-agentdojo.ts";
import { handWrittenSource } from "./hand-written.ts";
import { localManifestSource } from "./local-manifest.ts";
import { rJudgeSource } from "./r-judge.ts";
import { redcodeSource } from "./redcode.ts";
import { rogueSecuritySource } from "./rogue-security.ts";

export const ALL_SOURCES: Source[] = [
	redcodeSource,
	rogueSecuritySource,
	localManifestSource,
	handWrittenSource,
	rJudgeSource,
	controlArenaAgentdojoSource,
];

/** Look up a source by id. */
export function sourceById(id: string): Source | undefined {
	return ALL_SOURCES.find((s) => s.id === id);
}
