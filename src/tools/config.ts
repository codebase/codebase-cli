import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import { ConfigStore } from "../config/store.js";
import type { ToolContext } from "./types.js";

const Params = Type.Object({
	path: Type.Optional(
		Type.String({
			description:
				"Dotted path to read a single value (e.g. `permissions.allow`). Omit to return the whole merged config.",
		}),
	),
});

export type ConfigParams = Static<typeof Params>;

export interface ConfigDetails {
	path?: string;
	sources: readonly string[];
	value: unknown;
}

const DESCRIPTION = `Read the merged codebase-cli config (user defaults + project overrides + local overrides).

The config has three layers, merged later-wins for scalars, additive-merge for permission patterns:
  1. ~/.codebase/config.json          — user defaults
  2. <cwd>/.codebase/config.json      — project, committed
  3. ~/.codebase/config.local.json    — local override, gitignored

Useful for: checking which permission allowlists are active, reading user-set theme/model preferences, debugging why a tool was/wasn't auto-allowed.

This tool is read-only. To change config, edit the JSON files directly or ask the user to run a slash command.`;

export function createConfig(ctx: ToolContext): AgentTool<typeof Params, ConfigDetails> {
	return {
		name: "config",
		label: "Config",
		description: DESCRIPTION,
		parameters: Params,
		executionMode: "parallel",
		execute: async (_toolCallId, params) => {
			const store = new ConfigStore({ cwd: ctx.cwd });
			const merged = store.load();
			const value = params.path ? readPath(merged, params.path) : merged;
			const formatted = JSON.stringify(value, null, 2);
			return {
				content: [
					{
						type: "text",
						text: params.path
							? `${params.path}:\n${formatted}`
							: `merged config (sources: ${store.sources.join(", ")}):\n${formatted}`,
					},
				],
				details: {
					path: params.path,
					sources: store.sources,
					value,
				},
			};
		},
	};
}

/**
 * Resolve a dotted path against an object. Missing intermediate keys
 * yield `undefined`. Array indices via numeric segments are supported
 * (`messages.3.content`).
 */
function readPath(obj: unknown, path: string): unknown {
	const segments = path.split(".").filter((s) => s.length > 0);
	let current: unknown = obj;
	for (const seg of segments) {
		if (current === null || current === undefined) return undefined;
		if (Array.isArray(current)) {
			const idx = Number.parseInt(seg, 10);
			if (Number.isNaN(idx)) return undefined;
			current = current[idx];
			continue;
		}
		if (typeof current === "object") {
			current = (current as Record<string, unknown>)[seg];
			continue;
		}
		return undefined;
	}
	return current;
}
