/**
 * Redact obvious secrets from a command line before it is recorded to disk.
 *
 * The stop handoff and its session entry preserve *what was attempted* so a person can decide
 * what to do next — but an unattended change call may carry a credential on its command line
 * (`curl -H 'Authorization: Bearer …'`, `--password …`, an `sk-…`/`ghp_…`/AWS key). Writing that
 * verbatim into a plaintext file in the repo tree would leak it. This scrubs the obvious shapes.
 *
 * This is a best-effort scrub of well-known patterns, not a guarantee: it is one layer behind the
 * real containment (run pi interactively, or declare a sandbox — see PI_GURU_SANDBOXED).
 */

const REPLACEMENT = "[redacted]";

/** Redact well-known credential shapes from `text`, preserving the surrounding command. */
export function redactSecrets(text: string): string {
	let out = text;
	// Authorization header value (any scheme, e.g. `Authorization: Bearer <tok>` / `Basic <b64>`),
	// stopping at a closing quote so the rest of the command survives.
	out = out.replace(/\b(Authorization\s*:\s*)([^'"\s]+(?:\s+[^'"\s]+)?)/gi, `$1${REPLACEMENT}`);
	// Bare Bearer tokens outside a header.
	out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REPLACEMENT}`);
	// `--password <value>` and `--password=<value>` (stop at a quote/space).
	out = out.replace(/(--password(?:=|\s+))[^'"\s]+/gi, `$1${REPLACEMENT}`);
	// token= / password= / passwd= / pwd= assignments and query params (stop at a quote/space).
	out = out.replace(/\b(token|password|passwd|pwd)=[^'"\s]+/gi, `$1=${REPLACEMENT}`);
	// Provider key shapes.
	out = out.replace(/\bsk-[A-Za-z0-9._-]+/g, REPLACEMENT);
	out = out.replace(/\bghp_[A-Za-z0-9]+/g, REPLACEMENT);
	// AWS access key ids (AKIA/ASIA + 16 uppercase alphanumerics).
	out = out.replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REPLACEMENT);
	return out;
}
