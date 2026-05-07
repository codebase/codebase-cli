import { Agent, type AgentEvent } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxText, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ChatState, EMPTY_USAGE } from "../types.js";
import { type Action, initialState, reducer } from "./events.js";

interface Harness {
	state: ChatState;
	events: AgentEvent[];
	dispatch(action: Action): void;
	unregister(): void;
}

function makeHarness(): Harness & { agent: Agent; faux: ReturnType<typeof registerFauxProvider> } {
	const faux = registerFauxProvider({
		models: [
			{
				id: "test-model",
				name: "Test Model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 100_000,
				maxTokens: 4096,
			},
		],
		tokenSize: { min: 1, max: 2 },
	});

	const model = faux.models[0];
	const agent = new Agent({
		initialState: { model, systemPrompt: "test", tools: [] },
		getApiKey: () => "faux-key",
	});

	const harness: Harness & { agent: Agent; faux: typeof faux } = {
		state: initialState({ provider: model.provider, id: model.id, name: model.name }),
		events: [],
		agent,
		faux,
		dispatch(action) {
			this.state = reducer(this.state, action);
		},
		unregister() {
			faux.unregister();
		},
	};

	agent.subscribe((event) => {
		harness.events.push(event);
		harness.dispatch({ type: "agent-event", event });
	});

	return harness;
}

function lastAssistantText(state: ChatState): string {
	for (let i = state.messages.length - 1; i >= 0; i--) {
		const msg = state.messages[i];
		if (msg.role === "assistant") {
			return msg.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
		}
	}
	return "";
}

describe("agent + reducer", () => {
	let harness: ReturnType<typeof makeHarness>;

	beforeEach(() => {
		harness = makeHarness();
	});

	afterEach(() => {
		harness.unregister();
	});

	it("round-trips a simple text response", async () => {
		harness.faux.setResponses([fauxAssistantMessage("Hello, world.")]);

		harness.dispatch({ type: "user-prompt", text: "Say hi." });
		await harness.agent.prompt({ role: "user", content: "Say hi.", timestamp: Date.now() });

		const types = harness.events.map((e) => e.type);
		expect(types).toContain("agent_start");
		expect(types).toContain("message_start");
		expect(types).toContain("message_end");
		expect(types).toContain("turn_end");
		expect(types).toContain("agent_end");

		expect(harness.state.status).toBe("idle");
		expect(harness.state.messages).toHaveLength(2);
		expect(lastAssistantText(harness.state)).toBe("Hello, world.");
		expect(harness.state.streaming).toBeUndefined();
	});

	it("emits message_update events while streaming", async () => {
		harness.faux.setResponses([fauxAssistantMessage("one two three four five")]);

		await harness.agent.prompt({
			role: "user",
			content: "stream please",
			timestamp: Date.now(),
		});

		const updates = harness.events.filter((e) => e.type === "message_update");
		expect(updates.length).toBeGreaterThan(1);
		expect(harness.state.status).toBe("idle");
		expect(lastAssistantText(harness.state)).toBe("one two three four five");
	});

	it("preserves cumulative usage across turns", async () => {
		harness.faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);

		await harness.agent.prompt({ role: "user", content: "1", timestamp: Date.now() });
		const afterFirst = { ...harness.state.usage };
		await harness.agent.prompt({ role: "user", content: "2", timestamp: Date.now() });
		const afterSecond = harness.state.usage;

		expect(afterFirst).not.toEqual(EMPTY_USAGE);
		expect(afterSecond.totalTokens).toBeGreaterThanOrEqual(afterFirst.totalTokens);
		expect(afterSecond.input).toBeGreaterThan(afterFirst.input);
	});

	it("aborts cleanly when abort is called mid-stream", async () => {
		harness.faux.setResponses([fauxAssistantMessage("a long enough message to stream over multiple ticks")]);

		const promptPromise = harness.agent.prompt({
			role: "user",
			content: "abort me",
			timestamp: Date.now(),
		});

		await new Promise((resolve) => queueMicrotask(resolve));
		harness.agent.abort();
		harness.dispatch({ type: "abort" });

		await promptPromise.catch(() => {});

		expect(["aborted", "idle", "error"]).toContain(harness.state.status);
	});

	it("handles error responses without crashing", async () => {
		harness.faux.setResponses([
			fauxAssistantMessage([fauxText("partial output")], {
				stopReason: "error",
				errorMessage: "simulated provider failure",
			}),
		]);

		await harness.agent.prompt({
			role: "user",
			content: "fail please",
			timestamp: Date.now(),
		});

		expect(harness.events.some((e) => e.type === "agent_end")).toBe(true);
		expect(harness.state.messages.length).toBeGreaterThanOrEqual(1);
	});
});
