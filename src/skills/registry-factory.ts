import { AssetRegistry } from "./loader.js";
import { LocalLoader } from "./local-loader.js";
import { PlatformLoader, type PlatformLoaderOptions } from "./platform-loader.js";

export interface BuildAssetRegistryOptions {
	/**
	 * Root dir for the LocalLoader. Defaults to `~/.codebase/`. Tests
	 * supply a tmp dir.
	 */
	localRoot?: string;
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
 * registered in resolution order: local first (lowest priority),
 * then platform (highest). Later loaders win when ids collide, so
 * platform-shipped assets shadow user-local ones with the same id.
 *
 * Consumers read from `bundle.assets` — a future `/skills` dispatcher
 * or system-prompt augmenter pulls the list at turn boundaries.
 */
export function buildAssetRegistry(opts: BuildAssetRegistryOptions = {}): AssetRegistry {
	const registry = new AssetRegistry();
	registry.register(new LocalLoader(opts.localRoot));
	if (opts.platform) {
		registry.register(new PlatformLoader(opts.platform));
	}
	return registry;
}
