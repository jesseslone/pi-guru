/**
 * Sandbox detection: decide, from pi's own environment, whether a launcher has
 * declared OS-level confinement for this run. Read once at extension load — never from a tool
 * call. Two signals, in order of authority:
 *
 *   1. `PI_GURU_SANDBOXED=1` — an explicit declaration from a sandbox launcher (any platform).
 *   2. Linux-container heuristics — a convenience: `/.dockerenv`, or a container runtime named in
 *      `/proc/1/cgroup`. Linux only; a macOS seatbelt sandbox is never inferred.
 *
 * The probe (env, platform, filesystem) is injected so the logic is unit-testable without a real
 * container. `defaultProbe()` wires it to the live process.
 */

import { existsSync, readFileSync } from "node:fs";
import type { SandboxSignal } from "./pipeline.ts";

export type { SandboxSignal };

/** The ambient facts sandbox detection reads. Injected so tests need no real container. */
export interface SandboxProbe {
	env: NodeJS.ProcessEnv;
	platform: NodeJS.Platform;
	fileExists: (path: string) => boolean;
	readFile: (path: string) => string;
}

/** Container runtimes recognised in `/proc/1/cgroup`. */
const CONTAINER_RUNTIMES = /(docker|containerd|lxc|podman)/i;

/** The live process probe. */
export function defaultProbe(): SandboxProbe {
	return {
		env: process.env,
		platform: process.platform,
		fileExists: (path) => existsSync(path),
		readFile: (path) => readFileSync(path, "utf8"),
	};
}

/** Detect a declared or auto-detected sandbox. Explicit env wins; container heuristics follow. */
export function detectSandbox(probe: SandboxProbe = defaultProbe()): SandboxSignal {
	if (probe.env.PI_GURU_SANDBOXED === "1") {
		return { active: true, signal: "PI_GURU_SANDBOXED=1" };
	}
	if (probe.platform === "linux") {
		const container = detectLinuxContainer(probe);
		if (container) return { active: true, signal: container };
	}
	return { active: false, signal: "" };
}

/** A Linux-container signal, or undefined: `/.dockerenv`, then a runtime named in the cgroup. */
function detectLinuxContainer(probe: SandboxProbe): string | undefined {
	try {
		if (probe.fileExists("/.dockerenv")) return "container (/.dockerenv)";
	} catch {
		// unreadable — fall through to the cgroup check
	}
	try {
		const match = CONTAINER_RUNTIMES.exec(probe.readFile("/proc/1/cgroup"));
		if (match) return `container (cgroup: ${match[1].toLowerCase()})`;
	} catch {
		// no /proc/1/cgroup (or unreadable) — not a detectable container
	}
	return undefined;
}
