/**
 * A tolerant parser for Python/JSON object literals.
 *
 * rogue-security's `data_to_evaluate` is a stringified message dict that appears in two forms —
 * single-quoted Python (`{'role': 'assistant', ...}`, with `True`/`False`/`None`) and ordinary
 * double-quoted JSON — sometimes with nested quotes and multi-line string values. `JSON.parse`
 * handles only the second; a regex would break on the embedded quotes. So this is a small
 * recursive-descent reader over objects, arrays, strings (either quote, backslash escapes),
 * numbers, and the three Python constants, returning a plain JS value. It throws on malformed
 * input, which the converter turns into a fail-closed skip rather than a garbage record.
 */

/** Parse a Python/JSON object-or-array literal into a plain JS value. */
export function parsePyLiteral(text: string): unknown {
	const reader = new Reader(text);
	reader.skipWs();
	const value = reader.readValue();
	reader.skipWs();
	if (!reader.atEnd()) throw new Error("trailing characters after literal");
	return value;
}

class Reader {
	private i = 0;
	private readonly s: string;

	constructor(s: string) {
		this.s = s;
	}

	atEnd(): boolean {
		return this.i >= this.s.length;
	}

	skipWs(): void {
		while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++;
	}

	readValue(): unknown {
		this.skipWs();
		const ch = this.s[this.i];
		if (ch === "{") return this.readObject();
		if (ch === "[") return this.readArray();
		if (ch === '"' || ch === "'") return this.readString();
		return this.readBareword();
	}

	private readObject(): Record<string, unknown> {
		this.expect("{");
		const obj: Record<string, unknown> = {};
		this.skipWs();
		if (this.s[this.i] === "}") {
			this.i++;
			return obj;
		}
		for (;;) {
			this.skipWs();
			const key = String(this.readString());
			this.skipWs();
			this.expect(":");
			obj[key] = this.readValue();
			this.skipWs();
			const sep = this.s[this.i++];
			if (sep === "}") return obj;
			if (sep !== ",") throw new Error(`expected , or } in object, got ${sep ?? "EOF"}`);
		}
	}

	private readArray(): unknown[] {
		this.expect("[");
		const arr: unknown[] = [];
		this.skipWs();
		if (this.s[this.i] === "]") {
			this.i++;
			return arr;
		}
		for (;;) {
			arr.push(this.readValue());
			this.skipWs();
			const sep = this.s[this.i++];
			if (sep === "]") return arr;
			if (sep !== ",") throw new Error(`expected , or ] in array, got ${sep ?? "EOF"}`);
		}
	}

	private readString(): string {
		const quote = this.s[this.i];
		if (quote !== '"' && quote !== "'") throw new Error(`expected a string, got ${quote ?? "EOF"}`);
		this.i++;
		let out = "";
		while (this.i < this.s.length) {
			const ch = this.s[this.i++];
			if (ch === "\\") {
				out += this.readEscape();
				continue;
			}
			if (ch === quote) return out;
			out += ch;
		}
		throw new Error("unterminated string");
	}

	private readEscape(): string {
		const ch = this.s[this.i++];
		switch (ch) {
			case "n":
				return "\n";
			case "t":
				return "\t";
			case "r":
				return "\r";
			case "b":
				return "\b";
			case "f":
				return "\f";
			case "/":
				return "/";
			case "\\":
				return "\\";
			case '"':
				return '"';
			case "'":
				return "'";
			case "0":
				return "\0";
			case "u": {
				const hex = this.s.slice(this.i, this.i + 4);
				this.i += 4;
				return String.fromCharCode(Number.parseInt(hex, 16));
			}
			case "x": {
				const hex = this.s.slice(this.i, this.i + 2);
				this.i += 2;
				return String.fromCharCode(Number.parseInt(hex, 16));
			}
			default:
				return ch ?? "";
		}
	}

	/** A bareword: a number, or one of `True`/`False`/`None`/`true`/`false`/`null`. */
	private readBareword(): unknown {
		const start = this.i;
		while (this.i < this.s.length && /[^,{}[\]:\s]/.test(this.s[this.i])) this.i++;
		const word = this.s.slice(start, this.i);
		if (word === "True" || word === "true") return true;
		if (word === "False" || word === "false") return false;
		if (word === "None" || word === "null") return null;
		const num = Number(word);
		if (word !== "" && !Number.isNaN(num)) return num;
		throw new Error(`unexpected token '${word || this.s[this.i] || "EOF"}'`);
	}

	private expect(ch: string): void {
		if (this.s[this.i] !== ch) throw new Error(`expected '${ch}', got '${this.s[this.i] ?? "EOF"}'`);
		this.i++;
	}
}
