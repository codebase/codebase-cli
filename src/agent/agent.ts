import { Agent, type AgentEvent } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
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
	subscribe: (listener: (event: AgentEvent) => void) => () => void;
}

export function createAgent(opts: CreateAgentOptions = {}): AgentBundle {
	const { model, apiKey, source } = resolveConfig();
	const cwd = opts.cwd ?? process.cwd();
	const systemPrompt = opts.systemPrompt ?? buildSystemPrompt(cwd);
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
	});

	const subscribe = (listener: (event: AgentEvent) => void): (() => void) =>
		agent.subscribe((event) => {
			listener(event);
		});

	return { agent, model, source, toolContext, subscribe };
}
