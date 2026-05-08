import type { AgentMessage } from "@earendil-works/pi-agent-core";

export interface CompactionDetails {
	/** Files the agent read in the truncated portion (paths relative to cwd). */
	readFiles: string[];
	/** Files the agent modified in the truncated portion. */
	modifiedFiles: string[];
	/** LLM-generated summary of the truncated portion. */
	summary: string;
	/** Approximate tokens removed from the in-memory transcript. */
	truncatedTokens: number;
	/** How many messages were collapsed into the summary. */
	collapsedMessageCount: number;
}

export interface CompactionResult {
	messages: AgentMessage[];
	details: CompactionDetails;
}
