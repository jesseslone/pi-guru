/**
 * A hand-curated binary-capability table. GTFOBins is the canonical source but is
 * GPL-3.0, and pi-guru is MIT, so this is a short table written from man pages for the dozen-odd
 * binaries that matter (per `docs/research/risk-assessors.md`, option (d) — hand-write the entries).
 *
 * A capability alone is never a fact: `python --version` is not a shell. The assessor emits the
 * `binary-capability` fact only when the AST shows a *qualifying argument* — a host/URL for the
 * network binaries, a file operand for the file binaries, an inline-code flag for the interpreters —
 * so the fact reports a capability the command actually exercises.
 */

/** What a binary can do that is worth telling the judge about. */
export type Capability = "network" | "file" | "shell";

/** One curated binary: the capabilities it carries and a neutral phrase for the fact text. */
export interface BinaryEntry {
	capabilities: Capability[];
	phrase: string;
}

/**
 * The curated table. `network` binaries move data over the network; `file` binaries read or write
 * arbitrary files; `shell` interpreters run inline code. A binary can carry more than one.
 */
export const BINARY_TABLE: Record<string, BinaryEntry> = {
	curl: { capabilities: ["network", "file"], phrase: "can upload or download data over the network" },
	wget: { capabilities: ["network", "file"], phrase: "can download data over the network" },
	nc: { capabilities: ["network", "shell"], phrase: "can open a raw network connection or spawn a shell" },
	ncat: { capabilities: ["network", "shell"], phrase: "can open a raw network connection or spawn a shell" },
	socat: { capabilities: ["network", "shell"], phrase: "can relay a network connection to a shell" },
	scp: { capabilities: ["network", "file"], phrase: "can copy files to or from a remote host" },
	rsync: { capabilities: ["network", "file"], phrase: "can sync files to or from a remote host" },
	python: { capabilities: ["shell", "network"], phrase: "can run inline code or open a network connection" },
	python3: { capabilities: ["shell", "network"], phrase: "can run inline code or open a network connection" },
	perl: { capabilities: ["shell", "network"], phrase: "can run inline code or open a network connection" },
	ruby: { capabilities: ["shell", "network"], phrase: "can run inline code or open a network connection" },
	php: { capabilities: ["shell", "network"], phrase: "can run inline code or open a network connection" },
	base64: { capabilities: ["file"], phrase: "can encode or decode file contents" },
	xxd: { capabilities: ["file"], phrase: "can dump or patch file contents" },
	openssl: { capabilities: ["network", "file"], phrase: "can open a TLS connection or read/write files" },
	tar: { capabilities: ["file"], phrase: "can read or write arbitrary files, including outside the tree" },
	dd: { capabilities: ["file"], phrase: "can read or overwrite raw files and devices" },
};

/** A curated binary's entry, or undefined when it is not in the table. */
export function binaryEntry(name: string): BinaryEntry | undefined {
	return BINARY_TABLE[name];
}
