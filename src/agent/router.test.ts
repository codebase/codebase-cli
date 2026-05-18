import { describe, expect, it, vi } from "vitest";
import type { GlueClient } from "../glue/client.js";
import { routeUserInput } from "./router.js";

function mockGlue(replies: { intent?: string }): GlueClient {
	const fast = vi.fn(async (_prompt: string, system?: string) => {
		if (system?.includes("classify")) return replies.intent ?? "agent";
		return "agent";
	});
	return { fast, smart: fast } as unknown as GlueClient;
}

describe("routeUserInput", () => {
	it("returns 'agent' for actionable requests", async () => {
		const glue = mockGlue({ intent: "agent" });
		await expect(routeUserInput(glue, "fix the build", { hasHistory: true })).resolves.toEqual({ kind: "agent" });
	});

	it("returns 'plan' when intent classifies to plan", async () => {
		const glue = mockGlue({ intent: "plan" });
		await expect(
			routeUserInput(glue, "rewrite the worker as a state machine", { hasHistory: false }),
		).resolves.toEqual({ kind: "plan" });
	});

	it("routes greetings to the agent (the chat-intercept path is gone)", async () => {
		// Greetings used to be hijacked into a glue chat reply with no tools
		// or context. They now go straight to the main agent like any other
		// turn — the system prompt teaches it to handle small talk briefly.
		const glue = mockGlue({ intent: "agent" });
		await expect(routeUserInput(glue, "hi", { hasHistory: true })).resolves.toEqual({ kind: "agent" });
	});

	it("treats an unexpected intent as agent (failing open)", async () => {
		const glue = mockGlue({ intent: "clarify" });
		await expect(routeUserInput(glue, "what should I do next?", { hasHistory: true })).resolves.toEqual({
			kind: "agent",
		});
	});

	it("falls back to 'agent' when intent classification errors", async () => {
		const failingGlue = {
			fast: vi.fn(async () => {
				throw new Error("network");
			}),
			smart: vi.fn(),
		} as unknown as GlueClient;
		await expect(routeUserInput(failingGlue, "fix the build", { hasHistory: true })).resolves.toEqual({
			kind: "agent",
		});
	});
});
