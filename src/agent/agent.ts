import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { Agent, type AgentEvent } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { DiagnosticsEngine, formatDiagnostics } from "../diagnostics/engine.js";
import { HookManager } from "../hooks/manager.js";
import { PermissionStore } from "../permissions/store.js";
import { FileStateCache } from "../tools/file-state-cache.js";
import { buildTools } from "../tools/registry.js";
import { TaskStore } from "../tools/task-store.js";
import type { ToolContext } from "../tools/types.js";
import { UserQueryStore } from "../user-queries/store.js";
import { type ResolvedConfig, resolveConfig } from "./config.js";
import { buildSystemPrompt } from "./system-prompt.js";

const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set(["write_file", "edit_file", "multi_edit", "notebook_edit"]);

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
	userQueries: UserQueryStore;
	hooks: HookManager;
	diagnostics: DiagnosticsEngine;
	subscribe: (listener: (event: AgentEvent) => void) => () => void;
}

export function createAgent(opts: CreateAgentOptions = {}): AgentBundle {
	const { model, apiKey, source } = resolveConfig();
	const cwd = opts.cwd ?? process.cwd();
	const systemPrompt = opts.systemPrompt ?? buildSystemPrompt(cwd);

	const permissions = new PermissionStore();
	const userQueries = new UserQueryStore();
	const hooks = new HookManager();
	hooks.loadFrom(join(homedir(), ".codebase", "hooks.json"), join(cwd, ".codebase", "hooks.json"));
	const diagnostics = new DiagnosticsEngine({ cwd });

	const toolContext: ToolContext = {
		cwd,
		fileStateCache: new FileStateCache(),
		tasks: new TaskStore(),
		userQueries,
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

			// After a write/edit tool, run language checkers on the affected file
			// and steer the result into the next turn. Fire-and-forget so the
			// tool result return isn't blocked by a 15s checker run.
			if (filePath && WRITE_TOOL_NAMES.has(ctx.toolCall.name)) {
				const absPath = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
				diagnostics
					.forFiles([absPath], signal)
					.then((diags) => {
						if (diags.length === 0) return;
						const body = formatDiagnostics(diags);
						agentRef?.steer({
							role: "user",
							content: `<system-reminder>\n${body}\n</system-reminder>`,
							timestamp: Date.now(),
						});
					})
					.catch(() => {
						// Diagnostics failures are non-fatal — surface nothing.
					});
			}
			return undefined;
		},
	});

	// agentRef lets the afterToolCall closure call agent.steer() once the
	// Agent is constructed. JS hoisting makes the assignment safe because
	// afterToolCall fires inside the event loop, well after this assignment.
	const agentRef: Agent = agent;

	const subscribe = (listener: (event: AgentEvent) => void): (() => void) =>
		agent.subscribe((event) => {
			listener(event);
		});

	void agentRef;
	return { agent, model, source, toolContext, permissions, userQueries, hooks, diagnostics, subscribe };
}
