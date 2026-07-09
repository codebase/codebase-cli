import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_PROXY_RESPONSE_TIMEOUT_MS,
	proxyResponseTimeoutMs,
	sanitizeAssistantMessage,
	sanitizeAssistantStream,
	stripDsmlProtocol,
} from "./safe-stream.js";

function message(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "openai",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 1,
	};
}

describe("stripDsmlProtocol", () => {
	it("removes full and partially streamed protocol markers", () => {
		expect(stripDsmlProtocol("Working on it.\n<｜DSML｜function_calls>bad")).toBe("Working on it.");
		expect(stripDsmlProtocol("Working on it.\n<｜DSM")).toBe("Working on it.");
	});
});

describe("proxyResponseTimeoutMs", () => {
	it("uses a bounded default and clamps explicit values", () => {
		expect(proxyResponseTimeoutMs(undefined)).toBe(DEFAULT_PROXY_RESPONSE_TIMEOUT_MS);
		expect(proxyResponseTimeoutMs("not-a-number")).toBe(DEFAULT_PROXY_RESPONSE_TIMEOUT_MS);
		expect(proxyResponseTimeoutMs("100")).toBe(10_000);
		expect(proxyResponseTimeoutMs("9999999")).toBe(600_000);
		expect(proxyResponseTimeoutMs("45000")).toBe(45_000);
	});
});

describe("sanitizeAssistantMessage", () => {
	it("drops textual protocol and duplicate semantic tool calls", () => {
		const clean = sanitizeAssistantMessage(
			message([
				{ type: "text", text: "I will inspect it.\n<|DSML|function_calls>duplicate" },
				{ type: "toolCall", id: "one", name: "read_file", arguments: { path: "a.ts", line: 1 } },
				{ type: "toolCall", id: "two", name: "read_file", arguments: { line: 1, path: "a.ts" } },
				{ type: "toolCall", id: "three", name: "read_file", arguments: { path: "b.ts" } },
			]),
		);

		expect(clean.content).toEqual([
			{ type: "text", text: "I will inspect it." },
			{ type: "toolCall", id: "one", name: "read_file", arguments: { path: "a.ts", line: 1 } },
			{ type: "toolCall", id: "three", name: "read_file", arguments: { path: "b.ts" } },
		]);
	});

	it("makes the sanitized final message the stream result used by the executor", async () => {
		const dirty = message([
			{ type: "toolCall", id: "one", name: "shell", arguments: { command: "npm test" } },
			{ type: "toolCall", id: "two", name: "shell", arguments: { command: "npm test" } },
		]);
		const upstream = createAssistantMessageEventStream();
		const safe = sanitizeAssistantStream(upstream);
		upstream.push({ type: "start", partial: dirty });
		upstream.push({ type: "done", reason: "toolUse", message: dirty });
		for await (const _event of safe) {
			// Drain the wrapped stream exactly as pi-agent-core does.
		}
		expect((await safe.result()).content).toHaveLength(1);
	});
});
