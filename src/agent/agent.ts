import { Agent, type AgentEvent } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { buildTools } from "../tools/registry.js";
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
	subscribe: (listener: (event: AgentEvent) => void) => () => void;
}

export function createAgent(opts: CreateAgentOptions = {}): AgentBundle {
	const { model, apiKey, source } = resolveConfig();
	const systemPrompt = opts.systemPrompt ?? buildSystemPrompt(opts.cwd);

	const agent = new Agent({
		initialState: {
			model,
			systemPrompt,
			tools: buildTools(),
			messages: [],
		},
		getApiKey: () => apiKey,
	});

	const subscribe = (listener: (event: AgentEvent) => void): (() => void) =>
		agent.subscribe((event) => {
			listener(event);
		});

	return { agent, model, source, subscribe };
}
