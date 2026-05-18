import { describe, expect, it, vi } from "vitest";
import { classifyIntent, parseIntent } from "./intent.js";

function fakeGlue(reply: string) {
	return {
		fast: vi.fn(async () => reply),
		smart: vi.fn(async () => reply),
	} as unknown as Parameters<typeof classifyIntent>[0];
}

function failingGlue() {
	return {
		fast: vi.fn(async () => {
			throw new Error("network");
		}),
		smart: vi.fn(async () => {
			throw new Error("network");
		}),
	} as unknown as Parameters<typeof classifyIntent>[0];
}

describe("parseIntent", () => {
	it("parses bare words", () => {
		expect(parseIntent("agent")).toBe("agent");
		expect(parseIntent("plan")).toBe("plan");
		expect(parseIntent("clarify")).toBe("clarify");
	});

	it("no longer recognizes the dead 'chat' intent", () => {
		// Chat was removed when we ripped out the glue intercept. A model
		// that still says "chat" gets null here so the caller defaults to
		// "agent" — which is what we want.
		expect(parseIntent("chat")).toBeNull();
	});

	it("strips trailing punctuation", () => {
		expect(parseIntent("agent.")).toBe("agent");
		expect(parseIntent("plan!")).toBe("plan");
	});

	it("picks the first matching token from messy replies", () => {
		expect(parseIntent("This is clearly an agent request.")).toBe("agent");
		expect(parseIntent("plan — multi-step")).toBe("plan");
	});

	it("returns null on unparseable input", () => {
		expect(parseIntent("xyzzy")).toBeNull();
		expect(parseIntent("")).toBeNull();
	});
});

describe("classifyIntent", () => {
	it("returns 'clarify' for empty input", async () => {
		const glue = fakeGlue("agent");
		await expect(classifyIntent(glue, "  ", { hasHistory: true })).resolves.toBe("clarify");
	});

	it("routes greetings to the agent (the glue chat shortcut is gone)", async () => {
		// Previously "thanks!" would have skipped the LLM and shortcut to
		// "chat". Now the classifier is asked, and the prompt explicitly
		// tells it small talk is the agent's job — so we expect "agent".
		const glue = fakeGlue("agent");
		await expect(classifyIntent(glue, "thanks!", { hasHistory: true })).resolves.toBe("agent");
		expect(glue.fast).toHaveBeenCalled();
	});

	it("returns the LLM-classified intent on success", async () => {
		const glue = fakeGlue("plan");
		await expect(classifyIntent(glue, "rewrite the worker as a state machine", { hasHistory: false })).resolves.toBe(
			"plan",
		);
	});

	it("falls back to 'agent' on LLM error", async () => {
		const glue = failingGlue();
		await expect(classifyIntent(glue, "fix the build", { hasHistory: true })).resolves.toBe("agent");
	});

	it("falls back to 'agent' when the LLM reply is gibberish", async () => {
		const glue = fakeGlue("idk lol");
		await expect(classifyIntent(glue, "do something", { hasHistory: true })).resolves.toBe("agent");
	});

	it("falls back to 'agent' when a stale model returns the removed 'chat' intent", async () => {
		// Belt-and-braces: if a cheap classifier still emits "chat" from
		// training data, we don't want to silently strand the request.
		const glue = fakeGlue("chat");
		await expect(classifyIntent(glue, "what's up", { hasHistory: true })).resolves.toBe("agent");
	});
});
