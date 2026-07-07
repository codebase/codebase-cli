import type { Credentials } from "./credentials.js";

export const DEFAULT_CODEBASE_SCOPES = ["inference", "projects", "credits", "builds:read", "builds:write"] as const;

export const WEB_BUILD_SCOPES = ["builds:read", "builds:write"] as const;

export type WebBuildScopeReadiness =
	| { status: "ready"; missing: []; message: string }
	| { status: "missing-scopes"; missing: string[]; message: string; fix: string }
	| { status: "byok"; missing: []; message: string; fix: string };

export function parseScopeList(value: string): string[] {
	return value.split(/\s+/).filter(Boolean);
}

export function missingScopes(granted: readonly string[], required: readonly string[]): string[] {
	const grantedSet = new Set(granted);
	return required.filter((scope) => !grantedSet.has(scope));
}

export function webBuildScopeReadiness(credentials: Pick<Credentials, "source" | "scopes">): WebBuildScopeReadiness {
	if (credentials.source === "byok") {
		return {
			status: "byok",
			missing: [],
			message: "requires codebase.design OAuth",
			fix: "run `codebase auth login` to use web builds",
		};
	}

	const missing = missingScopes(credentials.scopes, WEB_BUILD_SCOPES);
	if (missing.length === 0) {
		return { status: "ready", missing: [], message: "ready" };
	}

	return {
		status: "missing-scopes",
		missing,
		message: `missing build scopes: ${missing.join(" ")}`,
		fix: "run `codebase auth login`; if scopes stay missing, deploy the web OAuth seed with build scopes",
	};
}
