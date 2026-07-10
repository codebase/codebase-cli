/**
 * High-confidence secret redaction for public benchmark artifacts.
 *
 * Keep this focused on distinctive token formats. The benchmark verifier can
 * still inspect raw temporary agent output; this module protects durable JSONL,
 * markdown, and scorecard artifacts that may be published.
 */

export const SECRET_REDACTION_RULESET_VERSION = 1;

const ANTHROPIC_PREFIX = ["sk", "ant", "api"].join("-");

const SECRET_RULES = [
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

let redactRules = null;

export function redactBenchmarkValue(value) {
	if (typeof value === "string") return redactString(value);
	if (Array.isArray(value)) {
		let replacements = 0;
		const items = value.map((item) => {
			const redacted = redactBenchmarkValue(item);
			replacements += redacted.replacements;
			return redacted.value;
		});
		return { value: items, replacements };
	}
	if (!value || typeof value !== "object") return { value, replacements: 0 };

	let replacements = 0;
	const entries = Object.entries(value).map(([key, item]) => {
		const redacted = redactBenchmarkValue(item);
		replacements += redacted.replacements;
		return [key, redacted.value];
	});
	return { value: Object.fromEntries(entries), replacements };
}

export function redactBenchmarkRecord(record) {
	return redactBenchmarkValue(record);
}

function redactString(input) {
	redactRules ??= SECRET_RULES.map((rule) => new RegExp(rule.source, `${rule.flags ?? ""}g`));
	let value = input;
	let replacements = 0;
	for (const re of redactRules) {
		value = value.replace(re, (match, capture) => {
			replacements += 1;
			return typeof capture === "string" ? match.replace(capture, "[REDACTED]") : "[REDACTED]";
		});
	}
	return { value, replacements };
}
