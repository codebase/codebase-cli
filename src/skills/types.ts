/**
 * User-curated assets that augment a codebase-cli session. Three
 * shapes share the same "named, described, named-by-id" pattern but
 * play different roles:
 *
 *   - Skill    — slash-invocable prompt prefix. `/optimize` expands
 *                to the skill's systemPrompt before the agent runs.
 *   - Template — multi-file scaffold for new projects/components.
 *                "Spin up a Next.js app with auth wired" — the
 *                template emits the file tree, the agent customizes.
 *   - Prompt   — a saved prompt snippet the user reuses ad hoc.
 *
 * Each asset has a `source` so the UI can show provenance (bundled
 * with the CLI, in your local ~/.codebase/, or pulled from your
 * codebase.foundation account when you're OAuth'd in). Same id +
 * different source means platform overrides bundled overrides local
 * — surprising but matches how npm scopes work and gives users a way
 * to opt out of a platform-shipped skill by overriding it locally.
 */

export type AssetSource = "bundled" | "user" | "platform";

export interface SkillAsset {
	kind: "skill";
	id: string;
	source: AssetSource;
	name: string;
	description: string;
	/** Markdown body inserted as a system-prompt prefix on /<id> invocation. */
	systemPrompt: string;
	/** Optional tags for organization. */
	tags?: readonly string[];
	/** Hint about which model to prefer (UI suggestion only). */
	preferredModel?: string;
}

export interface TemplateAsset {
	kind: "template";
	id: string;
	source: AssetSource;
	name: string;
	description: string;
	/** Free-form instructions handed to the agent on apply. */
	body: string;
	/** Optional file tree the agent should emit before customizing. */
	files?: readonly { path: string; content: string }[];
	tags?: readonly string[];
}

export interface PromptAsset {
	kind: "prompt";
	id: string;
	source: AssetSource;
	name: string;
	description: string;
	/** The prompt body the user wants to reuse. */
	body: string;
	tags?: readonly string[];
}

export type Asset = SkillAsset | TemplateAsset | PromptAsset;
