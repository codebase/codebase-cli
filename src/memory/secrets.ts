/**
 * High-confidence secret redaction for memory writes.
 *
 * Memory is durable by design, so a mistaken `save_memory` call should not
 * preserve obvious API keys or private keys forever. Keep this list focused on
 * distinctive prefixes; generic "token=..." heuristics create too much noise.
 */

type SecretRule = {
	id: string;
	source: string;
	flags?: string;
};

const ANTHROPIC_PREFIX = ["sk", "ant", "api"].join("-");

const SECRET_RULES: readonly SecretRule[] = [
	{ id: "aws-access-token", source: "\\b((?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16})\\b" },
	{ id: "anthropic-api-key", source: `\\b(${ANTHROPIC_PREFIX}03-[a-zA-Z0-9_-]{93}AA)\\b` },
	{ id: "anthropic-admin-api-key", source: "\\b(sk-ant-admin01-[a-zA-Z0-9_-]{93}AA)\\b" },
	{
		id: "openai-api-key",
		source:
			"\\b(sk-(?:proj|svcacct|admin)-(?:[A-Za-z0-9_-]{74}|[A-Za-z0-9_-]{58})T3BlbkFJ(?:[A-Za-z0-9_-]{74}|[A-Za-z0-9_-]{58})\\b|sk-[a-zA-Z0-9]{20}T3BlbkFJ[a-zA-Z0-9]{20})\\b",
	},
	{ id: "github-pat", source: "\\b(ghp_[0-9a-zA-Z]{36})\\b" },
	{ id: "github-fine-grained-pat", source: "\\b(github_pat_\\w{82})\\b" },
	{ id: "github-app-token", source: "\\b((?:ghu|ghs)_[0-9a-zA-Z]{36})\\b" },
	{ id: "github-oauth", source: "\\b(gho_[0-9a-zA-Z]{36})\\b" },
	{ id: "github-refresh-token", source: "\\b(ghr_[0-9a-zA-Z]{36})\\b" },
	{ id: "gitlab-pat", source: "\\b(glpat-[\\w-]{20})\\b" },
	{ id: "slack-bot-token", source: "\\b(xoxb-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9-]*)\\b" },
	{ id: "npm-access-token", source: "\\b(npm_[a-zA-Z0-9]{36})\\b" },
	{ id: "stripe-access-token", source: "\\b((?:sk|rk)_(?:test|live|prod)_[a-zA-Z0-9]{10,99})\\b" },
	{
		id: "private-key",
		source:
			"-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----[\\s\\S-]{64,}?-----END[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----",
		flags: "i",
	},
];

let redactRules: RegExp[] | null = null;

export function redactSecrets(input: string): string {
	redactRules ??= SECRET_RULES.map((rule) => new RegExp(rule.source, `${rule.flags ?? ""}g`));
	let out = input;
	for (const re of redactRules) {
		out = out.replace(re, (match, capture) =>
			typeof capture === "string" ? match.replace(capture, "[REDACTED]") : "[REDACTED]",
		);
	}
	return out;
}
