import type { AgentBundle } from "../agent/agent.js";
import type { ChatState } from "../types.js";
import type { CommandRegistry } from "./registry.js";

export interface CommandContext {
	bundle: AgentBundle;
	state: ChatState;
	/** Append a status line below the next assistant message. */
	emit: (text: string) => void;
	/** Clear visible chat history (display only — agent messages preserved). */
	clearDisplay: () => void;
	/** Exit the app cleanly. */
	exit: () => void;
	/**
	 * The registry that dispatched this command. Threaded through so
	 * meta-commands like /help can list their siblings without the App
	 * needing to import every command's metadata separately.
	 */
	registry: CommandRegistry;
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
