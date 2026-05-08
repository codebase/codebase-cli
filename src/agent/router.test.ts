import { describe, expect, it, vi } from "vitest";
import type { GlueClient } from "../glue/client.js";
import { routeUserInput } from "./router.js";

function mockGlue(replies: { intent?: string; chat?: string }): GlueClient {
	const fast = vi.fn(async (_prompt: string, system?: string) => {
		if (system?.includes("classify")) return replies.intent ?? "agent";
		if (system?.includes("chatting casually")) return replies.chat ?? "ok";
		return "agent";
	});
	return { fast, smart: fast } as unknown as GlueClient;
}

describe("routeUserInput", () => {
	it("returns 'agent' for actionable requests", async () => {
		const glue = mockGlue({ intent: "agent" });
		await expect(routeUserInput(glue, "fix the build", { hasHistory: true })).resolves.toEqual({ kind: "agent" });
	});

	it("returns 'chat' with a glue reply when intent classifies to chat", async () => {
		const glue = mockGlue({ intent: "chat", chat: "you're welcome!" });
		const out = await routeUserInput(glue, "thanks", { hasHistory: true });
		expect(out.kind).toBe("chat");
		if (out.kind === "chat") expect(out.reply).toBe("you're welcome!");
	});

	it("short-circuits greetings to chat without an LLM intent call", async () => {
		const glue = mockGlue({ chat: "hello there" });
		const out = await routeUserInput(glue, "hi", { hasHistory: true });
		expect(out.kind).toBe("chat");
		// greeting fast-track in classifyIntent skips the intent call entirely;
		// only the chat-reply call to glue.fast should fire.
		expect(glue.fast).toHaveBeenCalledTimes(1);
	});

	it("returns 'plan' when intent is plan", async () => {
		const glue = mockGlue({ intent: "plan" });
		await expect(
			routeUserInput(glue, "rewrite the worker as a state machine", { hasHistory: false }),
		).resolves.toEqual({
			kind: "plan",
		});
	});

	it("falls back to 'chat' with a placeholder when chat reply fails", async () => {
		const failingGlue = {
			fast: vi.fn(async (_p: string, system?: string) => {
				if (system?.includes("classify")) return "chat";
				throw new Error("network");
			}),
			smart: vi.fn(),
		} as unknown as GlueClient;
		const out = await routeUserInput(failingGlue, "thanks", { hasHistory: true });
		expect(out.kind).toBe("chat");
		if (out.kind === "chat") expect(out.reply).toBe("👍");
	});

	it("falls back to 'agent' when intent classification errors", async () => {
		const failingGlue = {
			fast: vi.fn(async () => {
				throw new Error("network");
			}),
			smart: vi.fn(),
		} as unknown as GlueClient;
		// Use a non-greeting input — greetings short-circuit to chat before the
		// LLM is consulted, which would change the test premise.
		await expect(routeUserInput(failingGlue, "fix the build", { hasHistory: true })).resolves.toEqual({
			kind: "agent",
		});
	});
});
