export type HookEvent =
	| "PreToolUse"
	| "PostToolUse"
	| "PostEdit"
	| "UserPromptSubmit"
	| "SessionStart"
	| "Stop"
	| "PreCompact"
	| "PostCompact"
	| "SubagentStart"
	| "SubagentStop";

export interface HookConfig {
	/** When this hook fires. */
	event: HookEvent;
	/**
	 * Optional pattern. Format: "tool" or "tool|tool" (alternatives) or
	 * "tool:pathGlob". A bare "*" matches anything for that segment.
	 * If omitted, the hook fires for every event of its type.
	 */
	matcher?: string;
	/** Shell command to run. Receives the event payload as JSON on stdin. */
	command: string;
	/** Kill the hook after this many ms. Default 30000. */
	timeout?: number;
	/** Run the hook fire-and-forget. Default false (blocking). */
	async?: boolean;
}

export interface HooksFile {
	hooks: HookConfig[];
}

export interface HookEventContext {
	event: HookEvent;
	toolName?: string;
	toolArgs?: unknown;
	/** A file path associated with the event, if any (for matchers like "edit_file:*.ts"). */
	filePath?: string;
	workingDir: string;

	// Compaction-specific (PreCompact / PostCompact):
	/** Total message count BEFORE compaction (Pre) or AFTER (Post). */
	messageCount?: number;
	/** PostCompact only — how many messages got summarized away. */
	collapsedMessageCount?: number;
	/** PostCompact only — approximate tokens reclaimed. */
	truncatedTokens?: number;

	// Subagent-specific (SubagentStart / SubagentStop):
	/** SubagentStart/Stop — what kind of subagent (explore / plan / general). */
	subagentType?: string;
	/** SubagentStart only — the prompt the parent passed to the subagent. */
	subagentPrompt?: string;
	/** SubagentStop only — was the subagent run successful? */
	subagentSuccess?: boolean;
}

export interface HookResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface HookOutcome {
	/** True if any synchronous hook exited with code 2. The agent loop must abort the in-flight tool call. */
	blocked: boolean;
	/** Stderr from the blocking hook, surfaced to the model so it can self-correct. */
	reason?: string;
	/** How many hooks ran (sync + async). Useful for telemetry. */
	ranCount: number;
}
