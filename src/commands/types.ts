import type { AgentBundle } from "../agent/agent.js";
import type { ChatState } from "../types.js";

export interface CommandContext {
	bundle: AgentBundle;
	state: ChatState;
	/** Append a status line below the next assistant message. */
	emit: (text: string) => void;
	/** Clear visible chat history (display only — agent messages preserved). */
	clearDisplay: () => void;
	/** Exit the app cleanly. */
	exit: () => void;
}

export interface CommandResult {
	/** True if the input was handled here and should NOT fall through to the agent. */
	handled: boolean;
}

export interface Command {
	name: string;
	aliases?: readonly string[];
	description: string;
	/** True for commands that mutate session state (e.g. /compact, /clear). Mainly UI hint. */
	mutates?: boolean;
	handler: (args: string, ctx: CommandContext) => Promise<CommandResult> | CommandResult;
}
