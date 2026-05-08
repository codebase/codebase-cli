import { homedir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentEvent } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { HookManager } from "../hooks/manager.js";
import { PermissionStore } from "../permissions/store.js";
import { FileStateCache } from "../tools/file-state-cache.js";
import { buildTools } from "../tools/registry.js";
import { TaskStore } from "../tools/task-store.js";
import type { ToolContext } from "../tools/types.js";
import { type ResolvedConfig, resolveConfig } from "./config.js";
import { buildSystemPrompt } from "./system-prompt.js";

export interface CreateAgentOptions {
	cwd?: string;
	systemPrompt?: string;
}

export interface AgentBundle {
	agent: Agent;
	model: Model<string>;
	source: ResolvedConfig["source"];
	toolContext: ToolContext;
	permissions: PermissionStore;
	hooks: HookManager;
	subscribe: (listener: (event: AgentEvent) => void) => () => void;
}

export function createAgent(opts: CreateAgentOptions = {}): AgentBundle {
	const { model, apiKey, source } = resolveConfig();
	const cwd = opts.cwd ?? process.cwd();
	const systemPrompt = opts.systemPrompt ?? buildSystemPrompt(cwd);

	const permissions = new PermissionStore();
	const hooks = new HookManager();
	hooks.loadFrom(join(homedir(), ".codebase", "hooks.json"), join(cwd, ".codebase", "hooks.json"));

	const toolContext: ToolContext = {
		cwd,
		fileStateCache: new FileStateCache(),
		tasks: new TaskStore(),
		spawnSubagent: ({ systemPrompt: subPrompt, tools: subTools }) =>
			new Agent({
				initialState: { model, systemPrompt: subPrompt, tools: subTools },
				getApiKey: () => apiKey,
			}),
	};

	const agent = new Agent({
		initialState: {
			model,
			systemPrompt,
			tools: buildTools(toolContext),
			messages: [],
		},
		getApiKey: () => apiKey,
		beforeToolCall: async (ctx, signal) => {
			// 1. Built-in permission gate (fast, sync for read-only tools).
			const decision = await permissions.evaluate(ctx.toolCall.name, ctx.args);
			if (decision === "block") {
				return { block: true, reason: "Permission denied by user." };
			}
			// 2. User-defined hooks (typically audit/lint/validation steps).
			const filePath = (ctx.args as { path?: string } | undefined)?.path;
			const outcome = await hooks.dispatch(
				"PreToolUse",
				{
					event: "PreToolUse",
					toolName: ctx.toolCall.name,
					toolArgs: ctx.args,
					filePath,
					workingDir: cwd,
				},
				signal,
			);
			if (outcome.blocked) {
				return { block: true, reason: outcome.reason ?? "Blocked by hook." };
			}
			return undefined;
		},
		afterToolCall: async (ctx, signal) => {
			const filePath = (ctx.args as { path?: string } | undefined)?.path;
			await hooks.dispatch(
				"PostToolUse",
				{
					event: "PostToolUse",
					toolName: ctx.toolCall.name,
					toolArgs: ctx.args,
					filePath,
					workingDir: cwd,
				},
				signal,
			);
			// Diagnostics + steering messages land in their own commit; this hook
			// stays a pure pass-through for now.
			return undefined;
		},
	});

	const subscribe = (listener: (event: AgentEvent) => void): (() => void) =>
		agent.subscribe((event) => {
			listener(event);
		});

	return { agent, model, source, toolContext, permissions, hooks, subscribe };
}
