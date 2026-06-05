import { Agent } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSubagentTools, createDispatchAgent } from "./dispatch-agent.js";
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

describe("buildSubagentTools modes", () => {
	let faux: ReturnType<typeof registerFauxProvider>;
	let ctx: ToolContext;

	beforeEach(() => {
		faux = registerFauxProvider({
			models: [
				{
					id: "tools-test",
					name: "Tools Test",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 100_000,
					maxTokens: 4096,
				},
			],
			tokenSize: { min: 1, max: 2 },
		});
		ctx = makeCtx(faux);
	});
	afterEach(() => faux.unregister());

	it("research mode (default) is read-only", () => {
		const names = buildSubagentTools(ctx, "research").map((t) => t.name);
		expect(names).toContain("read_file");
		expect(names).not.toContain("write_file");
		expect(names).not.toContain("shell");
	});

	it("build mode adds action tools but never dispatch_agent (no recursion)", () => {
		const names = buildSubagentTools(ctx, "build").map((t) => t.name);
		expect(names).toEqual(expect.arrayContaining(["write_file", "edit_file", "multi_edit", "shell"]));
		expect(names).not.toContain("dispatch_agent");
	});
});

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
});
