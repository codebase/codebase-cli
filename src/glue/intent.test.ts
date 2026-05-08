import { describe, expect, it, vi } from "vitest";
import { classifyIntent, isGreeting, parseIntent } from "./intent.js";

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

describe("isGreeting", () => {
	it("matches short greetings and acknowledgements", () => {
		expect(isGreeting("hi")).toBe(true);
		expect(isGreeting("hey")).toBe(true);
		expect(isGreeting("thanks")).toBe(true);
		expect(isGreeting("ty")).toBe(true);
		expect(isGreeting("ok")).toBe(true);
		expect(isGreeting("good morning")).toBe(true);
	});

	it("rejects content that just starts with a greeting word", () => {
		expect(isGreeting("hi can you help me write a parser for json")).toBe(false);
		expect(isGreeting("thanks for your help with the auth refactor please review")).toBe(false);
	});

	it("rejects unrelated short messages", () => {
		expect(isGreeting("debug the build")).toBe(false);
		expect(isGreeting("read main.go")).toBe(false);
	});
});

describe("parseIntent", () => {
	it("parses bare words", () => {
		expect(parseIntent("agent")).toBe("agent");
		expect(parseIntent("plan")).toBe("plan");
		expect(parseIntent("chat")).toBe("chat");
		expect(parseIntent("clarify")).toBe("clarify");
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

	it("short-circuits greetings to 'chat' on continuation", async () => {
		const glue = fakeGlue("agent");
		await expect(classifyIntent(glue, "thanks!", { hasHistory: true })).resolves.toBe("chat");
		expect(glue.fast).not.toHaveBeenCalled();
	});

	it("does NOT short-circuit greetings on first message (no history)", async () => {
		const glue = fakeGlue("agent");
		await classifyIntent(glue, "hi", { hasHistory: false });
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
});
