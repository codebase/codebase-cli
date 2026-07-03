const PROVIDER_AUTH_PATTERNS = [
	/\bauthentication_error\b/i,
	/\binvalid[_ -]?(?:x-)?api[_ -]?key\b/i,
	/\bunauthorized\b/i,
	/\b401\b/,
];

export function providerAuthRecoveryMessage(raw: string): string | undefined {
	const trimmed = raw.trim();
	if (!trimmed) return undefined;
	if (!PROVIDER_AUTH_PATTERNS.some((re) => re.test(trimmed))) return undefined;
	if (!/(api[_ -]?key|x-api-key|authentication|unauthorized|401)/i.test(trimmed)) return undefined;
	return [
		"That API key was rejected by the provider.",
		"Run `codebase --new` to paste a new BYOK key, `codebase auth login` to use Codebase credits, or `/model` to switch providers.",
	].join(" ");
}

export function userFacingErrorMessage(raw: string): string {
	return providerAuthRecoveryMessage(raw) ?? raw.trim();
}
