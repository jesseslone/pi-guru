/**
 * An in-process secret-scanning table for write/edit content.
 *
 * The regexes below are copied from gitleaks' default config (MIT, https://github.com/gitleaks/gitleaks,
 * `config/gitleaks.toml`) — the 12 highest-precision, provider-anchored rules. Entropy checks are
 * deliberately **off** (they are gitleaks' main false-positive source; see
 * `docs/research/risk-assessors.md`, option (c)), so every rule here is keyword/prefix-anchored and
 * fires only on a structurally distinctive token. Spawning gitleaks (~320 ms, 21 MB) is avoided.
 *
 * A match's *value* is never put in a fact — the fact's evidence is the rule's human label only, so a
 * scanned secret is not forwarded to the judge model. This table is content-only; a credential *path*
 * is handled by `paths.ts`.
 */

/** One secret rule: a stable id, a human label (the fact evidence), and the anchored pattern. */
interface SecretRule {
	id: string;
	label: string;
	re: RegExp;
}

/** The copied gitleaks rules (MIT). Anchored, entropy off. */
const SECRET_RULES: SecretRule[] = [
	{
		id: "private-key",
		label: "a PEM private key block",
		re: /-----BEGIN[ A-Z0-9]*PRIVATE KEY-----/,
	},
	{
		id: "aws-access-key",
		label: "an AWS access key id",
		re: /\b(?:A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}\b/,
	},
	{
		id: "github-pat",
		label: "a GitHub personal access token",
		re: /\bghp_[0-9A-Za-z]{36}\b/,
	},
	{
		id: "github-fine-grained-pat",
		label: "a GitHub fine-grained personal access token",
		re: /\bgithub_pat_[0-9A-Za-z_]{82}\b/,
	},
	{
		id: "github-oauth",
		label: "a GitHub OAuth / app token",
		re: /\b(?:gho|ghu|ghs|ghr)_[0-9A-Za-z]{36}\b/,
	},
	{
		id: "gitlab-pat",
		label: "a GitLab personal access token",
		re: /\bglpat-[0-9A-Za-z_-]{20}\b/,
	},
	{
		id: "slack-token",
		label: "a Slack token",
		re: /\bxox[baprs]-(?:\d+-){1,}[a-zA-Z0-9]+\b/,
	},
	{
		id: "slack-webhook",
		label: "a Slack incoming webhook URL",
		re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9+/]+/,
	},
	{
		id: "stripe-secret-key",
		label: "a Stripe secret key",
		re: /\b(?:sk|rk)_live_[0-9a-zA-Z]{24}\b/,
	},
	{
		id: "gcp-api-key",
		label: "a Google API key",
		re: /\bAIza[0-9A-Za-z_-]{35}\b/,
	},
	{
		id: "npm-token",
		label: "an npm access token",
		re: /\bnpm_[0-9A-Za-z]{36}\b/,
	},
	{
		id: "sendgrid-api-key",
		label: "a SendGrid API key",
		re: /\bSG\.[0-9A-Za-z_-]{22}\.[0-9A-Za-z_-]{43}\b/,
	},
];

/** One matched secret rule (its id and label), for turning into a fact. */
export interface SecretMatch {
	id: string;
	label: string;
}

/** Every distinct secret rule that matches `content` (deduped by rule id, value never returned). */
export function scanSecrets(content: string): SecretMatch[] {
	const out: SecretMatch[] = [];
	const seen = new Set<string>();
	for (const rule of SECRET_RULES) {
		rule.re.lastIndex = 0;
		if (rule.re.test(content) && !seen.has(rule.id)) {
			seen.add(rule.id);
			out.push({ id: rule.id, label: rule.label });
		}
	}
	return out;
}
