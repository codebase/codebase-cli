import { join } from "node:path";
import { AssetRegistry } from "./loader.js";
import { LocalLoader } from "./local-loader.js";
import { PlatformLoader, type PlatformLoaderOptions } from "./platform-loader.js";

export interface BuildAssetRegistryOptions {
	/**
	 * Root dir for the user LocalLoader. Defaults to `~/.codebase/`.
	 * Tests supply a tmp dir.
	 */
	localRoot?: string;
	/**
	 * Project root (the agent's cwd). When set, a second LocalLoader
	 * reads `<projectRoot>/.codebase/{skills,templates,prompts}/` so
	 * repos can ship their own skills. Project assets shadow user
	 * assets on id collision.
	 */
	projectRoot?: string;
	/**
	 * If supplied, also registers PlatformLoader. Omit for offline
	 * builds / BYOK sessions where no codebase.foundation account
	 * exists; the registry still works with just local + bundled
	 * assets.
	 */
	platform?: PlatformLoaderOptions;
}

/**
 * Assemble the asset registry used by the agent. Loaders are
 * registered in resolution order: user-local first (lowest priority),
 * then project, then platform (highest). Later loaders win when ids
 * collide, so a repo-shipped skill shadows the user's and a
 * platform-shipped one shadows both.
 */
export function buildAssetRegistry(opts: BuildAssetRegistryOptions = {}): AssetRegistry {
	const registry = new AssetRegistry();
	registry.register(new LocalLoader(opts.localRoot));
	if (opts.projectRoot) {
		registry.register(new LocalLoader(join(opts.projectRoot, ".codebase"), "project"));
	}
	if (opts.platform) {
		registry.register(new PlatformLoader(opts.platform));
	}
	return registry;
}
