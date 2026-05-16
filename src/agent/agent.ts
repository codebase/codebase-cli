import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { Agent, type AgentEvent, type AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { defaultOAuthConfig } from "../auth/cli.js";
import { CredentialsStore } from "../auth/credentials.js";
import { TokenManager } from "../auth/token-manager.js";
import { CompactionEngine } from "../compaction/engine.js";
import { CompactionMonitor } from "../compaction/monitor.js";
import { ConfigStore } from "../config/store.js";
import { DiagnosticsEngine, formatDiagnostics } from "../diagnostics/engine.js";
import { GlueClient, resolveGlueModels } from "../glue/client.js";
import { HookManager } from "../hooks/manager.js";
import { buildMemoryAddendum } from "../memory/inject.js";
import { MemoryStore } from "../memory/store.js";
import { PermissionStore } from "../permissions/store.js";
import { PlanModeStore } from "../plan/store.js";
import { SessionStore } from "../sessions/store.js";
import type { AssetRegistry } from "../skills/loader.js";
import { buildAssetRegistry } from "../skills/registry-factory.js";
import { BackgroundShellStore } from "../tools/background-shell-store.js";
import { FileStateCache } from "../tools/file-state-cache.js";
import { buildTools } from "../tools/registry.js";
import { TaskStore } from "../tools/task-store.js";
import type { ToolContext } from "../tools/types.js";
import { UserQueryStore } from "../user-queries/store.js";
import { type ResolvedConfig, resolveConfig } from "./config.js";
import { buildProjectFilesAddendum } from "./project-files.js";
import { buildSystemPrompt } from "./system-prompt.js";

const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set(["write_file", "edit_file", "multi_edit", "notebook_edit"]);

/**
 * Tools blocked while plan mode is active. Anything that mutates working-tree
 * state, runs commands, or talks to git's index belongs here. Read tools
 * (read_file, list_files, glob, grep, dispatch_agent, web_*, git read trio)
 * stay available so the agent can investigate and write the plan.
 */
const PLAN_MODE_BLOCKED: ReadonlySet<string> = new Set([
	"write_file",
	"edit_file",
	"multi_edit",
	"notebook_edit",
	"shell",
	"git_commit",
	"git_branch",
	"enter_worktree",
	"exit_worktree",
]);

export interface CreateAgentOptions {
	cwd?: string;
	systemPrompt?: string;
	/** When true, attempt to resume the previous session for this cwd. Default false. */
	resume?: boolean;
	/**
	 * When true, every tool call that would prompt the user gets
	 * auto-approved instead. Set this only when there's no human at
	 * the terminal — `codebase run --auto-approve …`, bench harnesses,
	 * CI. The TUI never sets it; auto-approve in interactive mode
	 * defeats the entire permission system.
	 */
	autoApprove?: boolean;
	/**
	 * Test escape hatch. Skip resolveConfig() and inject a pre-built
	 * model + apiKey + source. Used by the E2E harness with pi-ai's
	 * faux provider so tests can run without env vars or credentials.
	 * Production code never sets this.
	 */
	configOverride?: { model: ResolvedConfig["model"]; apiKey: string; source: ResolvedConfig["source"] };
	/**
	 * Runtime model override for proxy/OAuth sessions. Lets the user swap
	 * models via /model without restarting. Format: `{ provider?, modelId }`.
	 * Provider is optional — when omitted, the model id is sent verbatim
	 * through the proxy and the backend's registry resolves it.
	 */
	modelOverride?: { provider?: string; modelId: string };
	/**
	 * Seed the agent's transcript from an in-memory message list rather
	 * than from `~/.codebase/sessions/`. Used by the runtime model switch:
	 * we rebuild the agent with the existing conversation so the user
	 * doesn't lose context, but we don't want to disk-roundtrip.
	 */
	initialMessages?: AgentMessage[];
}

export interface AgentBundle {
	agent: Agent;
	model: Model<string>;
	source: ResolvedConfig["source"];
	toolContext: ToolContext;
	permissions: PermissionStore;
	userQueries: UserQueryStore;
	planMode: PlanModeStore;
	memory: MemoryStore;
	glue: GlueClient;
	compaction: CompactionEngine;
	compactionMonitor: CompactionMonitor;
	sessions: SessionStore;
	hooks: HookManager;
	diagnostics: DiagnosticsEngine;
	/**
	 * Curated assets — skills, templates, prompts — sourced from
	 * ~/.codebase/{skills,templates,prompts}/ and (when signed in)
	 * codebase.foundation. Consumers read on demand; no auto-merge into
	 * the system prompt today.
	 */
	assets: AssetRegistry;
	subscribe: (listener: (event: AgentEvent) => void) => () => void;
	/**
	 * User-initiated prompt — fires UserPromptSubmit hooks; honors exit-code-2
	 * veto. Callers that originate prompts from real user input should use
	 * this instead of `agent.prompt()` directly.
	 */
	submitUserPrompt: (text: string) => Promise<{ submitted: boolean; reason?: string }>;
	/**
	 * Set when `--resume` actually loaded a prior session, with its
	 * timestamp + message count so the welcome banner can say
	 * "Resumed from 3h ago · 47 messages". Undefined for fresh sessions.
	 */
	resumedFrom?: { updatedAt: number; messageCount: number };
	/**
	 * The transcript loaded from a resumed session. Pi-agent-core already
	 * has these in its internal state — this exposes them so the UI's
	 * reducer can show the prior conversation on screen, not just in the
	 * model's context. Empty when starting fresh.
	 */
	resumedMessages: AgentMessage[];
	/** Tracks long-running shells the agent spawned via background mode. */
	backgroundShells: BackgroundShellStore;
}

export function createAgent(opts: CreateAgentOptions = {}): AgentBundle {
	const cwd = opts.cwd ?? process.cwd();

	// Persisted model preference from `~/.codebase/config.json` (set via
	// `/model`) seeds the override when the caller hasn't passed one
	// explicitly. Explicit runtime overrides still win.
	const persistedConfig = new ConfigStore({ cwd });
	const persistedModel = persistedConfig.preferredModel();
	const effectiveOverride =
		opts.modelOverride ??
		(persistedModel?.modelId ? { provider: persistedModel.provider, modelId: persistedModel.modelId } : undefined);
	const { model, apiKey, source } = opts.configOverride ?? resolveConfig({ modelOverride: effectiveOverride });

	// OAuth-sourced credentials rotate ~hourly; build a refresh-aware getter
	// so the agent never sends a stale access token after the first refresh
	// window. BYOK / explicit / auto sources use the static key passed in.
	const tokenManager =
		source === "proxy"
			? new TokenManager({ store: new CredentialsStore(), oauthConfig: defaultOAuthConfig() })
			: null;
	const getApiKey = tokenManager ? () => tokenManager.getAccessToken() : () => apiKey;

	const config = persistedConfig;
	const permissions = new PermissionStore({
		allowPatterns: config.allowPatterns(),
		denyPatterns: config.denyPatterns(),
		autoApprove: opts.autoApprove,
	});
	const userQueries = new UserQueryStore();
	const planMode = new PlanModeStore();
	const memory = new MemoryStore({ cwd });
	const hooks = new HookManager();
	hooks.loadFrom(join(homedir(), ".codebase", "hooks.json"), join(cwd, ".codebase", "hooks.json"));
	const diagnostics = new DiagnosticsEngine({ cwd });
	// PlatformLoader is gated on a real auth session — for now we skip
	// it (LocalLoader still works). A future change wires it once we have
	// a stable endpoint contract and the user is signed in.
	const assets = buildAssetRegistry();

	const glueModels = resolveGlueModels({ parentModel: model, parentApiKey: apiKey });
	const glue = new GlueClient({
		fastModel: glueModels.fast,
		smartModel: glueModels.smart,
		getApiKey,
	});
	// Pass model.contextWindow explicitly so proxy-synthesized models
	// (Codebase Auto, custom in-house IDs) get the real window instead of
	// the regex-based fallback in tokens.ts, which would otherwise lock
	// them at 128k and trigger compaction at ~96k on a 200k-context route.
	const compaction = new CompactionEngine({ glue, modelId: model.id, contextWindow: model.contextWindow });
	const compactionMonitor = new CompactionMonitor();
	const sessions = new SessionStore({ cwd });
	const resumed = opts.resume ? sessions.load(model.id) : null;

	const toolContext: ToolContext = {
		cwd,
		fileStateCache: new FileStateCache(),
		tasks: new TaskStore(),
		userQueries,
		planMode,
		memory,
		hooks,
		backgroundShells: new BackgroundShellStore(),
		spawnSubagent: ({ systemPrompt: subPrompt, tools: subTools }) =>
			new Agent({
				initialState: { model, systemPrompt: subPrompt, tools: subTools },
				getApiKey,
			}),
	};

	// Build tools once so we can both register them with the Agent AND
	// inject a one-liner per tool into the system prompt — saves the model
	// from discovering tool surface area through trial and error.
	const tools = buildTools(toolContext);

	const systemPrompt =
		opts.systemPrompt ??
		buildSystemPrompt({
			tools: tools.map((t) => ({ name: t.name, description: t.description })),
		});

	// MEMORY.md gets concatenated onto the system prompt at agent creation;
	// edits during a session don't take effect until next launch.
	// Project-instruction file (first of AGENTS.md / CLAUDE.md / CODEX.md /
	// .cursorrules) gets pinned to the prompt so the agent sees the
	// project's conventions on every turn. Memory addendum is appended
	// after — it's the user's accumulated long-term notes.
	const fullSystemPrompt = systemPrompt + buildProjectFilesAddendum(cwd) + buildMemoryAddendum(memory);

	const agent = new Agent({
		initialState: {
			model,
			systemPrompt: fullSystemPrompt,
			tools,
			messages: opts.initialMessages ?? resumed?.messages ?? [],
		},
		getApiKey: () => apiKey,
		transformContext: async (messages, signal) => {
			if (!compaction.needsCompaction(messages)) return messages;
			compactionMonitor.start(messages.length);
			try {
				await hooks.dispatch(
					"PreCompact",
					{ event: "PreCompact", workingDir: cwd, messageCount: messages.length },
					signal,
				);
				const result = await compaction.compact(messages, signal);
				await hooks.dispatch(
					"PostCompact",
					{
						event: "PostCompact",
						workingDir: cwd,
						messageCount: result.messages.length,
						collapsedMessageCount: result.details.collapsedMessageCount,
						truncatedTokens: result.details.truncatedTokens,
					},
					signal,
				);
				return result.messages;
			} finally {
				// Always clear — even if compact() threw, the user shouldn't
				// see a stuck "Compacting…" banner forever.
				compactionMonitor.end();
			}
		},
		beforeToolCall: async (ctx, signal) => {
			// 1. Plan mode gate: block destructive tools entirely while planning.
			if (planMode.isActive() && PLAN_MODE_BLOCKED.has(ctx.toolCall.name)) {
				return {
					block: true,
					reason:
						`${ctx.toolCall.name} is blocked while plan mode is active. ` +
						"Use exit_plan_mode after presenting your plan to regain write access.",
				};
			}
			// 2. Built-in permission gate (fast, sync for read-only tools).
			const decision = await permissions.evaluate(ctx.toolCall.name, ctx.args);
			if (decision === "block") {
				return { block: true, reason: "Permission denied by user." };
			}
			// 3. User-defined hooks (typically audit/lint/validation steps).
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

			// PostEdit fires for write-family tools so hooks can run formatters
			// / linters / commit-on-save scripts targeted specifically at file
			// mutations (instead of having to filter inside a generic
			// PostToolUse handler).
			if (filePath && WRITE_TOOL_NAMES.has(ctx.toolCall.name)) {
				await hooks.dispatch(
					"PostEdit",
					{ event: "PostEdit", toolName: ctx.toolCall.name, toolArgs: ctx.args, filePath, workingDir: cwd },
					signal,
				);
			}

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
					.catch((err) => {
						// Diagnostics failures are non-fatal — but always-stderr
						// instead of debug-only, because the previous behavior
						// (silent under default settings) hid a real production
						// bug where a checker hung and the user thought the tool
						// itself was slow. Visible to anyone watching the terminal;
						// the agent keeps running.
						process.stderr.write(
							`[diagnostics] ${absPath}: ${err instanceof Error ? err.message : String(err)}\n`,
						);
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

	// Persist after every agent_end so a crash mid-session doesn't lose work.
	agent.subscribe((event) => {
		if (event.type !== "agent_end") return;
		try {
			const messages = event.messages.length > 0 ? event.messages : (resumed?.messages ?? []);
			if (messages.length === 0) return;
			sessions.save({
				modelId: model.id,
				title: resumed?.title ?? null,
				messages,
				usage: resumed?.usage ?? {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			});
		} catch (err) {
			// Persistence is best-effort — never crash the agent over a write
			// failure. But silent failure used to mean the user lost work to
			// a full disk with no warning, so surface to stderr so support is
			// possible. Visible to anyone watching the terminal; the agent
			// keeps running.
			const msg = err instanceof Error ? err.message : String(err);
			process.stderr.write(`[session] save failed (${sessions.filePath}): ${msg}\n`);
		}

		// Stop fires once the agent settles after a turn — useful for "ping
		// my phone when the long task finishes" style hooks. Fire-and-forget
		// so a misconfigured hook can't gate the agent_end notification.
		const finalMessage = lastAssistantText(event.messages);
		void hooks.dispatch("Stop", { event: "Stop", workingDir: cwd, finalMessage }).catch(() => undefined);
	});

	// SessionStart fires once per createAgent. Lets hooks pre-seed context
	// (e.g. "add project status to memory") before any user prompt lands.
	// Fire-and-forget because nothing else is waiting on it.
	void hooks.dispatch("SessionStart", { event: "SessionStart", workingDir: cwd }).catch(() => undefined);

	/**
	 * Submit a user-initiated prompt — fires UserPromptSubmit through the
	 * hook chain first so audit / lint hooks can veto with exit code 2.
	 * Subagent prompts (dispatch-agent) skip this and call agent.prompt
	 * directly because they aren't user-initiated.
	 *
	 * Returns `{ submitted: false, reason }` when a sync hook blocked the
	 * submit, otherwise resolves to `{ submitted: true }` after the agent
	 * accepted the prompt. The agent's own turn lifecycle still emits
	 * events on bundle.subscribe.
	 */
	const submitUserPrompt = async (text: string): Promise<{ submitted: boolean; reason?: string }> => {
		const outcome = await hooks.dispatch("UserPromptSubmit", {
			event: "UserPromptSubmit",
			workingDir: cwd,
			userPrompt: text,
		});
		if (outcome.blocked) {
			return { submitted: false, reason: outcome.reason };
		}
		// Await the agent's turn so headless callers can chain on a real
		// promise that reflects when the conversation has settled. Interactive
		// callers don't await us — they subscribe to bundle.subscribe for the
		// streaming events independent of this resolution.
		try {
			await agent.prompt(text);
		} catch {
			// Agent errors flow out as agent_end events with errorMessage on
			// the bundle.subscribe stream; callers handle them there.
		}
		return { submitted: true };
	};

	void agentRef;
	return {
		agent,
		model,
		source,
		toolContext,
		permissions,
		userQueries,
		planMode,
		memory,
		glue,
		compaction,
		compactionMonitor,
		sessions,
		hooks,
		diagnostics,
		assets,
		subscribe,
		submitUserPrompt,
		resumedFrom: resumed ? { updatedAt: resumed.updatedAt, messageCount: resumed.messages.length } : undefined,
		resumedMessages: opts.initialMessages ?? resumed?.messages ?? [],
		backgroundShells: toolContext.backgroundShells,
	};
}

/** Extract the trailing assistant text content from an array of messages. */
function lastAssistantText(messages: AgentMessage[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== "assistant") continue;
		if (typeof m.content === "string") return m.content || undefined;
		if (Array.isArray(m.content)) {
			const text = m.content
				.filter((b): b is { type: "text"; text: string } => (b as { type: string }).type === "text")
				.map((b) => b.text)
				.join("");
			return text || undefined;
		}
		return undefined;
	}
	return undefined;
}
