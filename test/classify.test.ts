import { describe, expect, it } from "vitest";
import {
	classifyTool,
	extractArgTargets,
	extractCommandWords,
	extractRedirectTargets,
} from "../src/classify.ts";

describe("classifyTool", () => {
	it("treats built-in inspect tools as read calls", () => {
		for (const t of ["read", "grep", "find", "ls"]) {
			expect(classifyTool(t)).toBe("read");
		}
	});

	it("treats bash, write, edit as change calls", () => {
		for (const t of ["bash", "write", "edit"]) {
			expect(classifyTool(t)).toBe("change");
		}
	});

	it("never lets config reclassify bash/write/edit as read-only", () => {
		for (const t of ["bash", "write", "edit"]) {
			expect(classifyTool(t, ["bash", "write", "edit"])).toBe("change");
		}
		// A legitimate extra read-only tool still works alongside the guard.
		expect(classifyTool("web_search", ["bash", "web_search"])).toBe("read");
	});

	it("treats unknown tools as change calls", () => {
		expect(classifyTool("some_mcp_tool")).toBe("change");
	});

	it("honours the configured read-only tool list", () => {
		expect(classifyTool("web_search", ["web_search"])).toBe("read");
		expect(classifyTool("web_search")).toBe("change");
	});
});

describe("extractCommandWords", () => {
	it("extracts a single command word", () => {
		expect(extractCommandWords("echo hi")).toEqual({ resolved: true, words: ["echo"] });
	});

	it("collapses repeated command words across an && chain", () => {
		// `git status && git push` needs only `git` allowed — one allow.
		expect(extractCommandWords("git status && git push")).toEqual({ resolved: true, words: ["git"] });
	});

	it("extracts every distinct command word in a chain", () => {
		expect(extractCommandWords("npm run build; rm -rf dist").words.sort()).toEqual(["npm", "rm"]);
	});

	it("extracts across pipelines", () => {
		expect(extractCommandWords("cat x | grep y | wc -l").words.sort()).toEqual(["cat", "grep", "wc"]);
	});

	it("unwraps bash -c", () => {
		expect(extractCommandWords(`bash -c "git push"`)).toEqual({ resolved: true, words: ["git"] });
	});

	it("unwraps sh -c", () => {
		expect(extractCommandWords(`sh -c 'rm -rf /tmp/x'`)).toEqual({ resolved: true, words: ["rm"] });
	});

	it("unwraps eval", () => {
		expect(extractCommandWords(`eval "git status"`)).toEqual({ resolved: true, words: ["git"] });
	});

	it("unwraps sudo, not counting sudo itself", () => {
		expect(extractCommandWords("sudo systemctl restart nginx")).toEqual({
			resolved: true,
			words: ["systemctl"],
		});
	});

	it("unwraps sudo with an option that takes an argument", () => {
		expect(extractCommandWords("sudo -u deploy git pull")).toEqual({ resolved: true, words: ["git"] });
	});

	it("unwraps env with assignments", () => {
		expect(extractCommandWords("env FOO=1 BAR=2 node app.js")).toEqual({ resolved: true, words: ["node"] });
	});

	it("unwraps xargs", () => {
		expect(extractCommandWords("xargs rm").words).toEqual(["rm"]);
	});

	it("unwraps nohup", () => {
		expect(extractCommandWords("nohup npm start").words).toEqual(["npm"]);
	});

	it("unwraps nested wrappers preserving quoting", () => {
		expect(extractCommandWords(`sudo bash -c "rm -rf /tmp/y"`)).toEqual({ resolved: true, words: ["rm"] });
	});

	it("unwraps the time keyword form via the pipeline", () => {
		expect(extractCommandWords("time make build").words).toEqual(["make"]);
	});

	it("marks a parse failure as unresolved", () => {
		expect(extractCommandWords("for do done (").resolved).toBe(false);
	});

	it("resolves a bare assignment to no command words", () => {
		expect(extractCommandWords("FOO=1")).toEqual({ resolved: true, words: [] });
	});

	it("descends into subshells", () => {
		expect(extractCommandWords("(cd /tmp && rm x)").words.sort()).toEqual(["cd", "rm"]);
	});

	// C2: substitution and non-allowlisted wrappers are unresolved, so they
	// can never match a session allow and always gate.
	it("marks command substitution as unresolved", () => {
		expect(extractCommandWords("echo $(rm -rf x)").resolved).toBe(false);
		expect(extractCommandWords("echo `rm -rf x`").resolved).toBe(false);
		expect(extractCommandWords('echo "hi $(rm x)"').resolved).toBe(false); // nested in quotes
		expect(extractCommandWords("FOO=$(rm x) echo hi").resolved).toBe(false); // in an assignment
		expect(extractCommandWords("echo hi > $(echo out)").resolved).toBe(false); // in a redirect
	});

	it("marks process substitution as unresolved", () => {
		expect(extractCommandWords("diff <(rm -rf x) y").resolved).toBe(false);
	});

	it("marks a non-allowlisted wrapper as unresolved", () => {
		for (const cmd of [
			"timeout 5 rm -rf x",
			"nice rm x",
			"command rm x",
			"builtin cd /",
			"exec rm x",
			"script -c 'rm x' out",
			"ssh host rm x",
			"docker exec c rm x",
			"npx cli",
		]) {
			expect(extractCommandWords(cmd).resolved).toBe(false);
		}
	});

	it("marks inline-code interpreter forms (node -e / python -c) as unresolved", () => {
		expect(extractCommandWords("node -e 'x'").resolved).toBe(false);
		expect(extractCommandWords("node --eval 'x'").resolved).toBe(false);
		expect(extractCommandWords("node -p 'x'").resolved).toBe(false);
		expect(extractCommandWords("python -c 'x'").resolved).toBe(false);
		expect(extractCommandWords("python3 -c 'x'").resolved).toBe(false);
	});

	it("still resolves an interpreter running a script file (not inline code)", () => {
		expect(extractCommandWords("node app.js")).toEqual({ resolved: true, words: ["node"] });
		expect(extractCommandWords("python3 manage.py migrate")).toEqual({ resolved: true, words: ["python3"] });
	});

	it("still safely unwraps the allowlisted wrappers (unchanged)", () => {
		expect(extractCommandWords(`bash -c "git push"`)).toEqual({ resolved: true, words: ["git"] });
		expect(extractCommandWords("sudo systemctl restart nginx")).toEqual({
			resolved: true,
			words: ["systemctl"],
		});
		expect(extractCommandWords("env FOO=1 node app.js")).toEqual({ resolved: true, words: ["node"] });
	});
});

describe("extractRedirectTargets", () => {
	it("resolves a `>` target, de-obfuscating shell quote-concatenation", () => {
		expect(extractRedirectTargets("echo x > ~/.pi/agent/pi-gu''ru.json")).toEqual([
			"~/.pi/agent/pi-guru.json",
		]);
	});

	it("resolves a `>>` append target", () => {
		expect(extractRedirectTargets("cat key >> ~/.ssh/auth''orized_keys")).toEqual(["~/.ssh/authorized_keys"]);
	});

	it("collects targets across a pipeline / chain", () => {
		expect(extractRedirectTargets("echo a > one.txt && echo b >> two.txt").sort()).toEqual([
			"one.txt",
			"two.txt",
		]);
	});

	it("ignores input redirections — reading is not a change", () => {
		expect(extractRedirectTargets("cat < ~/.ssh/authorized_keys")).toEqual([]);
	});

	it("returns nothing for a command with no redirects, or an unparseable one", () => {
		expect(extractRedirectTargets("tee ~/.bashrc")).toEqual([]); // tee arg, not a redirect
		expect(extractRedirectTargets("for do done (")).toEqual([]); // parse error
	});
});

describe("extractArgTargets", () => {
	it("resolves the in-place file argument of sed -i (and its suffix/long forms)", () => {
		expect(extractArgTargets("sed -i s/a/b/ ~/.zshrc")).toContain("~/.zshrc");
		expect(extractArgTargets("sed -i.bak s/a/b/ ~/.zshrc")).toContain("~/.zshrc");
		expect(extractArgTargets("sed --in-place s/a/b/ ~/.zshrc")).toContain("~/.zshrc");
	});

	it("does NOT treat a plain sed (no -i) as a write — it only prints", () => {
		expect(extractArgTargets("sed s/a/b/ ~/.zshrc")).toEqual([]);
	});

	it("resolves every operand of tee/truncate/shred/rm/chmod/chown", () => {
		expect(extractArgTargets("tee ~/.bashrc")).toContain("~/.bashrc");
		expect(extractArgTargets("tee -a ~/.bashrc other.txt")).toEqual(["~/.bashrc", "other.txt"]);
		expect(extractArgTargets("truncate -s 0 ~/.zshrc")).toContain("~/.zshrc");
		expect(extractArgTargets("shred ~/.bashrc")).toContain("~/.bashrc");
		expect(extractArgTargets("rm ~/.bashrc")).toContain("~/.bashrc");
		expect(extractArgTargets("chmod 777 ~/.ssh/authorized_keys")).toContain("~/.ssh/authorized_keys");
		expect(extractArgTargets("chown root ~/.bashrc")).toContain("~/.bashrc");
	});

	it("takes only the destination of cp/mv/install/ln — sources are reads", () => {
		expect(extractArgTargets("cp ~/.bashrc /tmp/backup")).toEqual(["/tmp/backup"]);
		expect(extractArgTargets("mv evil.sh ~/.bashrc")).toEqual(["~/.bashrc"]);
		expect(extractArgTargets("install -m 755 evil ~/.bashrc")).toEqual(["~/.bashrc"]);
		expect(extractArgTargets("ln -s /tmp/x ~/.zshrc")).toEqual(["~/.zshrc"]);
	});

	it("reads the destination from -t / --target-directory for the dest-only writers", () => {
		expect(extractArgTargets("cp -t /etc/ a b")).toEqual(["/etc/"]);
		expect(extractArgTargets("cp --target-directory=/etc/ a b")).toEqual(["/etc/"]);
	});

	it("takes only dd's of= target, never its if= source", () => {
		expect(extractArgTargets("dd if=/dev/zero of=/dev/sda")).toEqual(["/dev/sda"]);
	});

	it("unwraps a leading sudo/doas to reach the writing command", () => {
		expect(extractArgTargets("sudo tee ~/.bashrc")).toContain("~/.bashrc");
		expect(extractArgTargets("sudo -u root tee ~/.bashrc")).toContain("~/.bashrc");
		expect(extractArgTargets("doas rm ~/.zshrc")).toContain("~/.zshrc");
	});

	it("honours a -- end-of-options marker", () => {
		expect(extractArgTargets("rm -- -rf ~/.bashrc")).toContain("~/.bashrc");
	});

	it("collects targets across a chain / pipeline", () => {
		expect(extractArgTargets("cat x && tee ~/.bashrc").sort()).toEqual(["~/.bashrc"]);
	});

	it("returns nothing for a non-writing command or an unparseable one", () => {
		expect(extractArgTargets("cat ~/.bashrc")).toEqual([]);
		expect(extractArgTargets("for do done (")).toEqual([]);
	});
});
