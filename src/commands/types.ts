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
	/**
	 * Mid-session model swap. `spec === null` resets to the default model
	 * (Codebase Auto for proxy users). Aborts the current turn if active,
	 * rebuilds the agent with the new model, preserves the transcript.
	 */
	switchModel: (spec: { provider?: string; modelId: string } | null) => Promise<void>;
	/**
	 * Open the inline interactive model picker. Triggered by `/model` with
	 * no args. The picker fetches the available-models list, renders an
	 * arrow-navigable overlay, and calls back into switchModel on Enter.
	 */
	openModelPicker: () => void;
	/**
	 * Swap the live conversation for a previously-saved session (by id from
	 * SessionStore.list()). Aborts the current turn if active, rebuilds the
	 * agent seeded with the resumed transcript, and replaces the on-screen
	 * history.
	 */
	switchSession: (sessionId: string) => Promise<void>;
	/**
	 * Open the interactive conversation-rewind picker (pi-tui only). Each
	 * entry is a prior user prompt; selecting one rolls the transcript and
	 * matching file edits back to before it. Undefined on UIs without the
	 * overlay — callers fall back to the file-checkpoint list.
	 */
	openRewindPicker?: () => void;
	/**
	 * Run a /tournament: race `count` agents on `task` in isolated
	 * worktrees, judge them, and open the merge picker (pi-tui only).
	 * Undefined on UIs without it.
	 */
	runTournament?: (task: string, count: number) => void;
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
