import type { Asset, AssetSource, PromptAsset, SkillAsset, TemplateAsset } from "./types.js";

/**
 * A loader is anything that can produce assets for a session. The
 * registry merges results from every registered loader on each list
 * call, so loaders can come and go (e.g. PlatformLoader becomes
 * available after the user runs `codebase auth login`).
 *
 * Phase 7 ships LocalLoader (reads ~/.codebase/skills/*.md). Phase 7+
 * ships PlatformLoader (fetches from codebase.foundation/api/cli/...)
 * — see platform-loader.ts for the planned wire format.
 */
export interface AssetLoader {
	source: AssetSource;
	listSkills(): Promise<readonly SkillAsset[]>;
	listTemplates(): Promise<readonly TemplateAsset[]>;
	listPrompts(): Promise<readonly PromptAsset[]>;
}

/**
 * Merge results from N loaders. Override semantics:
 *   platform > bundled > user (later loaders win)
 *
 * Why this order: platform-shipped assets are curated by the team
 * that maintains the CLI; bundled comes with the binary; user is
 * the local override. If the user wants to shadow a platform skill,
 * they can ship a local file with the same id — the user version
 * loses by default, but a future config switch can flip the priority.
 */
export class AssetRegistry {
	private readonly loaders: AssetLoader[] = [];

	register(loader: AssetLoader): void {
		this.loaders.push(loader);
	}

	async listAll(): Promise<readonly Asset[]> {
		const merged = new Map<string, Asset>();
		for (const loader of this.loaders) {
			const skills = await loader.listSkills();
			const templates = await loader.listTemplates();
			const prompts = await loader.listPrompts();
			for (const asset of [...skills, ...templates, ...prompts]) {
				merged.set(`${asset.kind}:${asset.id}`, asset);
			}
		}
		return Array.from(merged.values());
	}

	async listSkills(): Promise<readonly SkillAsset[]> {
		const all = await this.listAll();
		return all.filter((a): a is SkillAsset => a.kind === "skill");
	}

	async listTemplates(): Promise<readonly TemplateAsset[]> {
		const all = await this.listAll();
		return all.filter((a): a is TemplateAsset => a.kind === "template");
	}

	async listPrompts(): Promise<readonly PromptAsset[]> {
		const all = await this.listAll();
		return all.filter((a): a is PromptAsset => a.kind === "prompt");
	}
}
