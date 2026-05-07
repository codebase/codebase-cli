import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";

export type ChatStatus = "idle" | "thinking" | "streaming" | "tool" | "error" | "aborted";

export interface ToolExecution {
	id: string;
	name: string;
	args: unknown;
	status: "running" | "done" | "error";
	startedAt: number;
	endedAt?: number;
	result?: string;
	error?: string;
}

export interface ChatState {
	messages: AgentMessage[];
	streaming?: AgentMessage;
	tools: Map<string, ToolExecution>;
	status: ChatStatus;
	usage: Usage;
	turnUsage?: Usage;
	model: { provider: string; id: string; name: string };
	error?: string;
}

export const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
