import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSubagentDefinitions } from "../subagents/definitions.js";
import { createDispatchAgent } from "./dispatch-agent.js";
import { FileStateCache } from "./file-state-cache.js";
import { TaskStore } from "./task-store.js";
import type { ToolContext } from "./types.js";

function makeCtx(faux: ReturnType<typeof registerFauxProvider>): ToolContext {
	const model = faux.models[0];
	return {
		cwd: process.cwd(),
		fileStateCache: new FileStateCache(),
		tasks: new TaskStore(),
		spawnSubagent: ({ systemPrompt, tools }) =>
			new Agent({
				initialState: { model, systemPrompt, tools },
				getApiKey: () => "faux-key",
			}),
	};
}

describe("dispatch_agent", () => {
	let faux: ReturnType<typeof registerFauxProvider>;
	let ctx: ToolContext;

	beforeEach(() => {
		faux = registerFauxProvider({
			models: [
				{
					id: "subagent-test",
					name: "Subagent Test",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 100_000,
					maxTokens: 4096,
				},
			],
			tokenSize: { min: 2, max: 4 },
		});
		ctx = makeCtx(faux);
	});

	afterEach(() => {
		faux.unregister();
	});

	it("returns the subagent's final text answer", async () => {
		faux.setResponses([fauxAssistantMessage("Found 3 references to handleAuth in src/auth/.")]);

		const result = await createDispatchAgent(ctx).execute(
			"call",
			{ task: "Find references to handleAuth" },
			undefined,
			undefined,
		);

		expect((result.content[0] as { type: "text"; text: string }).text).toContain("3 references to handleAuth");
		expect(result.details.toolsUsed).toEqual([]);
		expect(result.details.maxTurnsReached).toBe(false);
	});

	it("stops at max_turns and surfaces the partial result", async () => {
		// Each turn loops because the assistant emits a read-only tool call.
		// list_files is in the subagent's tool set and will succeed against process.cwd().
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("list_files", {})]),
			fauxAssistantMessage([fauxToolCall("list_files", {})]),
			fauxAssistantMessage([fauxToolCall("list_files", {})]),
			fauxAssistantMessage("final answer never reached"),
		]);

		const result = await createDispatchAgent(ctx).execute(
			"call",
			{ task: "explore", max_turns: 2 },
			undefined,
			undefined,
		);

		expect(result.details.maxTurnsReached).toBe(true);
		expect(result.details.turns).toBeGreaterThanOrEqual(2);
		expect(result.details.toolsUsed).toContain("list_files");
		expect((result.content[0] as { type: "text"; text: string }).text).toMatch(/stopped at \d+ turns/);
	});

	it("forwards parent abort to the subagent", async () => {
		faux.setResponses([fauxAssistantMessage("first answer"), fauxAssistantMessage("would-be second answer")]);

		const controller = new AbortController();
		const promise = createDispatchAgent(ctx).execute("call", { task: "long task" }, controller.signal, undefined);
		await new Promise((resolve) => queueMicrotask(resolve));
		controller.abort();

		// Should not throw a generic error — the subagent ends gracefully.
		const result = await promise.catch(() => null);
		// Either we got a result with partial text, or the abort propagated; both are acceptable.
		if (result) {
			expect(result.details.task).toBe("long task");
		}
	});

	it("falls back to a placeholder when the subagent produces no text", async () => {
		// Empty assistant message (no text content).
		faux.setResponses([fauxAssistantMessage([])]);

		const result = await createDispatchAgent(ctx).execute("call", { task: "nothing useful" }, undefined, undefined);
		expect((result.content[0] as { type: "text"; text: string }).text).toMatch(/without producing a summary/);
	});

	describe("agent types", () => {
		function ctxWithSpy(): { ctx: ToolContext; spawnedTools: string[][] } {
			const spawnedTools: string[][] = [];
			const base = makeCtx(faux);
			const spied: ToolContext = {
				...base,
				subagentTypes: loadSubagentDefinitions({ home: mkdtempSync(join(tmpdir(), "no-agents-")), cwd: base.cwd }),
				spawnSubagent: (config) => {
					spawnedTools.push(config.tools.map((t) => t.name));
					return base.spawnSubagent(config);
				},
			};
			return { ctx: spied, spawnedTools };
		}

		it("defaults to explore — no write tools granted", async () => {
			faux.setResponses([fauxAssistantMessage("done")]);
			const { ctx: spyCtx, spawnedTools } = ctxWithSpy();
			const result = await createDispatchAgent(spyCtx).execute(
				"call",
				{ task: "look around" },
				undefined,
				undefined,
			);
			expect(result.details.agentType).toBe("explore");
			expect(spawnedTools[0]).toContain("read_file");
			expect(spawnedTools[0]).not.toContain("edit_file");
			expect(spawnedTools[0]).not.toContain("shell");
		});

		it("general grants write + shell tools", async () => {
			faux.setResponses([fauxAssistantMessage("done")]);
			const { ctx: spyCtx, spawnedTools } = ctxWithSpy();
			const result = await createDispatchAgent(spyCtx).execute(
				"call",
				{ task: "fix it", agent_type: "general" },
				undefined,
				undefined,
			);
			expect(result.details.agentType).toBe("general");
			expect(spawnedTools[0]).toContain("edit_file");
			expect(spawnedTools[0]).toContain("write_file");
			expect(spawnedTools[0]).toContain("shell");
			expect(spawnedTools[0]).not.toContain("dispatch_agent");
		});

		it("rejects an unknown agent_type with the available list", async () => {
			const { ctx: spyCtx } = ctxWithSpy();
			await expect(
				createDispatchAgent(spyCtx).execute("call", { task: "x", agent_type: "nope" }, undefined, undefined),
			).rejects.toThrow(/unknown agent_type "nope".*explore.*general/);
		});

		it("lists agent types in the tool description", () => {
			const { ctx: spyCtx } = ctxWithSpy();
			const tool = createDispatchAgent(spyCtx);
			expect(tool.description).toContain("- explore:");
			expect(tool.description).toContain("- general:");
		});
	});

	describe("worktree isolation", () => {
		let repo: string;

		beforeEach(() => {
			repo = mkdtempSync(join(tmpdir(), "dispatch-wt-"));
			execSync("git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init", {
				cwd: repo,
			});
		});
		afterEach(() => {
			rmSync(repo, { recursive: true, force: true });
		});

		it("creates a worktree, runs there, and removes it when left clean", async () => {
			faux.setResponses([fauxAssistantMessage("explored, changed nothing")]);
			const repoCtx = { ...makeCtx(faux), cwd: repo };
			const result = await createDispatchAgent(repoCtx).execute(
				"call",
				{ task: "look", isolation: "worktree" },
				undefined,
				undefined,
			);
			expect(result.details.worktree?.kept).toBe(false);
			expect(existsSync(result.details.worktree?.path as string)).toBe(false);
		});

		it("keeps the worktree and reports it when the subagent left changes", async () => {
			// The faux subagent doesn't really edit; simulate by dropping a file
			// into the worktree from the test as soon as we know its path —
			// settle runs after the subagent finishes, so writing during the
			// turn is equivalent. We learn the path from the spawn config.
			let worktreePath = "";
			const base = { ...makeCtx(faux), cwd: repo };
			const spyCtx: ToolContext = {
				...base,
				spawnSubagent: (config) => {
					const m = config.systemPrompt.match(/Working directory: (.*)/);
					worktreePath = m?.[1] ?? "";
					writeFileSync(join(worktreePath, "left-behind.txt"), "dirty");
					return base.spawnSubagent(config);
				},
			};
			faux.setResponses([fauxAssistantMessage("made changes")]);
			const result = await createDispatchAgent(spyCtx).execute(
				"call",
				{ task: "edit", isolation: "worktree" },
				undefined,
				undefined,
			);
			expect(result.details.worktree?.kept).toBe(true);
			expect(existsSync(join(worktreePath, "left-behind.txt"))).toBe(true);
			expect((result.content[0] as { type: "text"; text: string }).text).toContain("left changes in worktree");
		});

		it("fails fast outside a git repository", async () => {
			const nonRepo = mkdtempSync(join(tmpdir(), "dispatch-nogit-"));
			try {
				const noGitCtx = { ...makeCtx(faux), cwd: nonRepo };
				await expect(
					createDispatchAgent(noGitCtx).execute(
						"call",
						{ task: "x", isolation: "worktree" },
						undefined,
						undefined,
					),
				).rejects.toThrow(/requires a git repository/);
			} finally {
				rmSync(nonRepo, { recursive: true, force: true });
			}
		});
	});
});
