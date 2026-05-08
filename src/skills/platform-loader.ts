import type { CredentialsStore } from "../auth/credentials.js";
import type { AssetLoader } from "./loader.js";
import type { PromptAsset, SkillAsset, TemplateAsset } from "./types.js";

/**
 * Loader that fetches the user's curated skills, templates, and
 * prompts from their codebase.foundation account.
 *
 * NOT YET IMPLEMENTED. This file exists as a contract anchor so the
 * AssetRegistry already knows about the platform path: when the
 * Phase 7+ implementation lands, it slots in here without further
 * surgery to the agent or App layer.
 *
 * Wire format (planned):
 *
 *   GET https://codebase.foundation/api/cli/skills
 *   Authorization: Bearer <accessToken>
 *
 *   200 OK
 *   { "skills":    [ { id, name, description, systemPrompt, tags?, preferredModel? }, … ],
 *     "templates": [ { id, name, description, body, files?, tags? }, … ],
 *     "prompts":   [ { id, name, description, body, tags? }, … ] }
 *
 * Cache the response under ~/.codebase/cache/platform-assets.json with
 * an ETag header so subsequent CLI launches don't pay the round trip.
 * Refresh on `codebase auth refresh` or after 1 hour, whichever is
 * sooner. Refresh failures fall back to the cached response — never
 * leave a session stranded because the platform is briefly down.
 *
 * Not authenticated → returns empty lists, never throws. The user just
 * sees their bundled + local assets, which is the correct
 * unauthenticated UX.
 */
export class PlatformLoader implements AssetLoader {
	readonly source = "platform" as const;

	constructor(
		private readonly credentials: CredentialsStore,
		private readonly baseUrl: string = "https://codebase.foundation/api/cli",
	) {}

	async listSkills(): Promise<readonly SkillAsset[]> {
		void this.fetchOrEmpty;
		return [];
	}

	async listTemplates(): Promise<readonly TemplateAsset[]> {
		return [];
	}

	async listPrompts(): Promise<readonly PromptAsset[]> {
		return [];
	}

	/**
	 * Placeholder for the real fetch path. Implementation steps:
	 *   1. Read credentials; if absent or expired, return null.
	 *   2. GET ${baseUrl}/skills with Authorization: Bearer …
	 *   3. On 401, trigger refresh via OAuthFlow.refreshAccessToken.
	 *   4. On success, cache under ~/.codebase/cache/platform-assets.json.
	 *   5. On any failure post-401-retry, return cached response if any
	 *      and log a one-line warning.
	 */
	private async fetchOrEmpty(): Promise<unknown> {
		void this.credentials;
		void this.baseUrl;
		return null;
	}
}
