import { describe, expect, it } from "vitest";
import { detectSandbox, type SandboxProbe } from "../src/sandbox.ts";

/** A probe with everything off; override per test. */
function probe(over: Partial<SandboxProbe> = {}): SandboxProbe {
	return {
		env: {},
		platform: "linux",
		fileExists: () => false,
		readFile: () => {
			throw new Error("ENOENT");
		},
		...over,
	};
}

describe("detectSandbox — explicit signal", () => {
	it("PI_GURU_SANDBOXED=1 stands down on any platform, and names the signal", () => {
		for (const platform of ["linux", "darwin", "win32"] as NodeJS.Platform[]) {
			const s = detectSandbox(probe({ platform, env: { PI_GURU_SANDBOXED: "1" } }));
			expect(s.active).toBe(true);
			expect(s.signal).toBe("PI_GURU_SANDBOXED=1");
		}
	});

	it('any value other than exactly "1" does not stand down', () => {
		expect(detectSandbox(probe({ env: { PI_GURU_SANDBOXED: "0" } })).active).toBe(false);
		expect(detectSandbox(probe({ env: { PI_GURU_SANDBOXED: "true" } })).active).toBe(false);
		expect(detectSandbox(probe({ env: {} })).active).toBe(false);
	});
});

describe("detectSandbox — Linux container auto-detection", () => {
	it("detects /.dockerenv", () => {
		const s = detectSandbox(probe({ fileExists: (p) => p === "/.dockerenv" }));
		expect(s.active).toBe(true);
		expect(s.signal).toBe("container (/.dockerenv)");
	});

	it("detects docker/containerd/lxc/podman in /proc/1/cgroup and names the runtime", () => {
		for (const [runtime, line] of [
			["docker", "12:pids:/docker/abc123"],
			["containerd", "0::/system.slice/containerd.service"],
			["lxc", "1:name=systemd:/lxc/container1"],
			["podman", "0::/machine.slice/podman-abc.scope"],
		] as const) {
			const s = detectSandbox(probe({ readFile: (p) => (p === "/proc/1/cgroup" ? line : "") }));
			expect(s.active).toBe(true);
			expect(s.signal).toBe(`container (cgroup: ${runtime})`);
		}
	});

	it("a plain host (no /.dockerenv, ordinary cgroup) does not stand down", () => {
		const s = detectSandbox(probe({ readFile: () => "0::/init.scope" }));
		expect(s).toEqual({ active: false, signal: "" });
	});
});

describe("detectSandbox — never infers a macOS sandbox", () => {
	it("does not probe container heuristics off Linux (a darwin seatbelt is never inferred)", () => {
		const s = detectSandbox(
			probe({
				platform: "darwin",
				fileExists: () => true, // even if a /.dockerenv-like path existed
				readFile: () => "docker",
			}),
		);
		expect(s).toEqual({ active: false, signal: "" });
	});
});
