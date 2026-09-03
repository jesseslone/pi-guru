import { describe, expect, it } from "vitest";
import { buildRules, compileRules, hardDeny, hardDenyBash, hardDenyPath } from "../src/hard-deny.ts";

const rules = buildRules();
const deny = (s: string) => hardDeny(s, rules);

describe("hard deny — recursive delete of root or home", () => {
	it("blocks rm -rf /", () => {
		expect(deny("rm -rf /")).toBeTruthy();
	});
	it("blocks rm -rf ~", () => {
		expect(deny("rm -rf ~")).toBeTruthy();
	});
	it("blocks rm -rf $HOME", () => {
		expect(deny("rm -rf $HOME")).toBeTruthy();
	});
	it("blocks rm -fr with flags reversed", () => {
		expect(deny("rm -fr /")).toBeTruthy();
	});
	it("blocks rm --recursive --force ~", () => {
		expect(deny("rm --recursive --force ~")).toBeTruthy();
	});
	it("does not block a scoped recursive delete", () => {
		expect(deny("rm -rf ./build/cache")).toBeFalsy();
	});
	it("does not block a non-recursive rm of a file", () => {
		expect(deny("rm /tmp/scratch.txt")).toBeFalsy();
	});
});

describe("hard deny — shell startup files", () => {
	it("blocks appending to ~/.bashrc", () => {
		expect(deny("echo 'evil' >> ~/.bashrc")).toBeTruthy();
	});
	it("blocks writing .zshrc", () => {
		expect(deny("/home/user/.zshrc")).toBeTruthy();
	});
	it("blocks .profile and .zprofile", () => {
		expect(deny("~/.profile")).toBeTruthy();
		expect(deny("~/.zprofile")).toBeTruthy();
	});
	it("does not block an unrelated dotfile", () => {
		expect(deny("~/.gitconfig")).toBeFalsy();
	});
});

describe("hard deny — authorized_keys and crontab", () => {
	it("blocks authorized_keys writes", () => {
		expect(deny("cat key >> ~/.ssh/authorized_keys")).toBeTruthy();
	});
	it("blocks crontab modifications", () => {
		expect(deny("crontab -e")).toBeTruthy();
		expect(deny("crontab -r")).toBeTruthy();
		expect(deny("crontab myjobs.txt")).toBeTruthy();
		expect(deny("crontab")).toBeTruthy();
	});
	it("does NOT report crontab -l (list = read) as an edit", () => {
		expect(deny("crontab -l")).toBeFalsy();
		expect(deny("crontab -u deploy -l")).toBeFalsy();
	});
});

describe("hard deny — TLS verification disabling", () => {
	it("blocks curl --insecure", () => {
		expect(deny("curl --insecure https://x")).toBeTruthy();
	});
	it("blocks curl -k", () => {
		expect(deny("curl -k https://x")).toBeTruthy();
	});
	it("blocks NODE_TLS_REJECT_UNAUTHORIZED=0", () => {
		expect(deny("NODE_TLS_REJECT_UNAUTHORIZED=0 node app.js")).toBeTruthy();
	});
	it("blocks GIT_SSL_NO_VERIFY", () => {
		expect(deny("GIT_SSL_NO_VERIFY=true git fetch")).toBeTruthy();
	});
	it("does not block a plain curl", () => {
		expect(deny("curl https://x")).toBeFalsy();
	});
});

describe("hard deny — chmod 777 on root or home", () => {
	it("blocks chmod 777 /", () => {
		expect(deny("chmod 777 /")).toBeTruthy();
	});
	it("blocks chmod -R 777 ~", () => {
		expect(deny("chmod -R 777 ~")).toBeTruthy();
	});
	it("does not block chmod 777 on a scoped path", () => {
		expect(deny("chmod 777 ./tmp/socket")).toBeFalsy();
	});
});

describe("hard deny — pi-guru config file", () => {
	it("blocks a write to the project config path", () => {
		expect(deny(".pi/pi-guru.json")).toBeTruthy();
	});
	it("blocks a write to the global agent config path", () => {
		expect(deny("/Users/x/.pi/agent/pi-guru.json")).toBeTruthy();
	});
	it("does NOT block a bare pi-guru.json outside .pi/", () => {
		// The broad `\bpi-guru\.json\b` substring rule is gone; only the path-anchored
		// `.pi/(agent/)?pi-guru.json` is protected. A file merely named pi-guru.json is not it.
		expect(deny("echo x > pi-guru.json")).toBeFalsy();
	});
});

describe("hard deny — config-supplied rules", () => {
	it("applies an extra regex source from config", () => {
		const withExtra = buildRules(["\\bterraform\\s+destroy\\b"]);
		expect(hardDeny("terraform destroy", withExtra)).toBeTruthy();
		expect(hardDeny("terraform plan", withExtra)).toBeFalsy();
	});
	it("ignores a malformed config regex without crashing", () => {
		const withBad = buildRules(["(unclosed"]);
		expect(() => hardDeny("anything", withBad)).not.toThrow();
	});
});

describe("hard deny — catastrophic-backtracking sources are rejected", () => {
	it("drops a configured rule with nested unbounded quantifiers", () => {
		expect(compileRules([{ source: "(a+)+$", flags: "", reason: "x" }])).toHaveLength(0);
		expect(compileRules([{ source: "(a*)*", flags: "", reason: "x" }])).toHaveLength(0);
		expect(compileRules([{ source: "(\\d+)+z", flags: "", reason: "x" }])).toHaveLength(0);
	});
	it("keeps a safe configured rule", () => {
		expect(compileRules([{ source: "\\bterraform\\s+destroy\\b", flags: "", reason: "x" }])).toHaveLength(1);
	});
	it("keeps every seed rule (none is catastrophic)", () => {
		expect(buildRules().length).toBeGreaterThan(0);
		// A representative seed subject still matches, proving the seed rules survived compilation.
		expect(hardDeny("rm -rf /", buildRules())).toBeTruthy();
	});
	it("bounds an over-long subject before matching", () => {
		const huge = `${"a".repeat(50_000)} rm -rf /`;
		const t0 = Date.now();
		hardDeny(huge, buildRules());
		expect(Date.now() - t0).toBeLessThan(50);
	});
});

describe("hard deny — benign commands pass", () => {
	it("allows an ordinary write", () => {
		expect(deny("echo hi > notes.txt")).toBeFalsy();
	});
	it("allows a git status", () => {
		expect(deny("git status")).toBeFalsy();
	});
});

describe("hardDenyBash — path rules resolve redirection targets", () => {
	it("matches command rules against the raw command text", () => {
		expect(hardDenyBash("rm -rf /", rules)).toBeTruthy();
		expect(hardDenyBash("curl -k https://x", rules)).toBeTruthy();
		expect(hardDenyBash("chmod 777 /", rules)).toBeTruthy();
	});

	it("matches path rules against the resolved redirection target, defeating obfuscation", () => {
		expect(hardDenyBash("echo x > ~/.pi/agent/pi-gu''ru.json", rules)).toBeTruthy();
		expect(hardDenyBash("cat k >> ~/.ssh/auth''orized_keys", rules)).toBeTruthy();
		expect(hardDenyBash("echo evil >> ~/.bash''rc", rules)).toBeTruthy();
	});

	it("does NOT hard-deny a command that merely mentions a protected path (no redirect)", () => {
		expect(hardDenyBash("gh issue create --body 'edit .pi/pi-guru.json please'", rules)).toBeFalsy();
		expect(hardDenyBash("echo 'remember to source ~/.bashrc'", rules)).toBeFalsy();
	});

	it("does NOT hard-deny an ordinary redirection to a safe file", () => {
		expect(hardDenyBash("echo hi > notes.txt", rules)).toBeFalsy();
		expect(hardDenyBash("npm run build >> build.log", rules)).toBeFalsy();
	});

	it("still honours a config rule against the raw command", () => {
		const withExtra = buildRules(["\\bterraform\\s+destroy\\b"]);
		expect(hardDenyBash("terraform destroy", withExtra)).toBeTruthy();
	});
});

describe("hardDenyBash — path rules resolve writing-command arguments", () => {
	it("blocks sed -i / tee to a protected path passed as an argument (not a redirect)", () => {
		expect(hardDenyBash("sed -i s/a/b/ ~/.zshrc", rules)).toBeTruthy();
		expect(hardDenyBash("tee ~/.bashrc < payload", rules)).toBeTruthy();
	});

	it("blocks cp/mv/install/ln/truncate/shred/chmod/chown/dd onto a protected path", () => {
		expect(hardDenyBash("cp evil ~/.bashrc", rules)).toBeTruthy();
		expect(hardDenyBash("mv evil ~/.zshrc", rules)).toBeTruthy();
		expect(hardDenyBash("install -m 755 evil ~/.bashrc", rules)).toBeTruthy();
		expect(hardDenyBash("ln -s /tmp/x ~/.ssh/authorized_keys", rules)).toBeTruthy();
		expect(hardDenyBash("truncate -s 0 ~/.zshrc", rules)).toBeTruthy();
		expect(hardDenyBash("shred ~/.bashrc", rules)).toBeTruthy();
		expect(hardDenyBash("dd if=/dev/zero of=/Users/x/.pi/agent/pi-guru.json", rules)).toBeTruthy();
	});

	it("blocks a write to pi-guru's own config through a command argument", () => {
		expect(hardDenyBash("tee /Users/x/.pi/agent/pi-guru.json", rules)).toBeTruthy();
	});

	it("catches an escalated write through a leading sudo", () => {
		expect(hardDenyBash("sudo tee ~/.bashrc", rules)).toBeTruthy();
	});

	it("does NOT flag a protected path used only as a READ source (cp source, dd if=)", () => {
		// Reading a protected file is not a change; only the destination is a write target (D2).
		expect(hardDenyBash("cp ~/.bashrc /tmp/backup", rules)).toBeFalsy();
		expect(hardDenyBash("dd if=/Users/x/.pi/agent/pi-guru.json of=/tmp/out", rules)).toBeFalsy();
	});

	it("does NOT flag a plain sed (no -i) that merely reads a protected path", () => {
		expect(hardDenyBash("sed s/a/b/ ~/.zshrc", rules)).toBeFalsy();
	});

	it("does NOT flag a writing command onto an ordinary, unprotected path", () => {
		expect(hardDenyBash("tee build.log", rules)).toBeFalsy();
		expect(hardDenyBash("cp a b", rules)).toBeFalsy();
		expect(hardDenyBash("rm -rf ./build/cache", rules)).toBeFalsy();
	});
});

describe("hardDenyPath — write/edit target paths", () => {
	it("blocks the pi-guru config, shell startup files, and authorized_keys as targets", () => {
		expect(hardDenyPath(".pi/pi-guru.json", rules)).toBeTruthy();
		expect(hardDenyPath("/Users/x/.pi/agent/pi-guru.json", rules)).toBeTruthy();
		expect(hardDenyPath("/home/user/.zshrc", rules)).toBeTruthy();
		expect(hardDenyPath("/home/user/.ssh/authorized_keys", rules)).toBeTruthy();
	});

	it("does not block a bare pi-guru.json outside .pi/ or an unrelated dotfile", () => {
		expect(hardDenyPath("pi-guru.json", rules)).toBeFalsy();
		expect(hardDenyPath("~/.gitconfig", rules)).toBeFalsy();
	});

	it("command rules never fire against a plain file path", () => {
		// A path that happens to contain 'crontab' is not a shell command.
		expect(hardDenyPath("/tmp/notes-about-crontab.txt", rules)).toBeFalsy();
	});

	it("still honours a config rule against the target path", () => {
		const withExtra = buildRules(["secrets\\.env"]);
		expect(hardDenyPath("config/secrets.env", withExtra)).toBeTruthy();
	});
});
