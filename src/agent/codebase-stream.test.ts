import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { BillingLedger, formatBillingSummary, parseBillingReceipt } from "./codebase-billing.js";
import { createCodebaseStream } from "./codebase-stream.js";

let server: Server | undefined;
afterEach(async () => {
	server?.closeAllConnections();
	if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
});
async function serve(chunks: unknown[], status = 200) {
	let request: Record<string, unknown> | undefined;
	server = createServer(async (req, res) => {
		let raw = "";
		for await (const bytes of req) raw += bytes;
		request = JSON.parse(raw);
		res.writeHead(status, { "content-type": status === 200 ? "text/event-stream" : "application/json" });
		if (status !== 200) return res.end(JSON.stringify(chunks[0]));
		for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
		res.end("data: [DONE]\n\n");
	});
	await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
	const model: Model<string> = {
		id: "d4f",
		name: "Auto",
		provider: "codebase",
		api: "openai-completions",
		baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		reasoning: false,
		input: ["text"],
		contextWindow: 131072,
		maxTokens: 8192,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	const ledger = new BillingLedger();
	const stream = createCodebaseStream(ledger, model.baseUrl!);
	return {
		ledger,
		model,
		stream,
		request: () => request,
		run: (signal?: AbortSignal) =>
			stream(
				model,
				{ systemPrompt: "Be concise", messages: [{ role: "user", content: "hi", timestamp: 1 }] },
				{ apiKey: "fake-key", signal },
			),
	};
}
const final = {
	model: "deepseek-flash",
	choices: [],
	usage: {
		prompt_tokens: 100,
		completion_tokens: 10,
		total_tokens: 110,
		prompt_tokens_details: { cached_tokens: 80, cache_write_tokens: 5 },
	},
	codebase_billing: { credits_charged: 3, usage_estimated: false },
};

describe("Codebase receipt transport", () => {
	it("uses the SDK stream with terminal usage-only receipts and the actual fallback model", async () => {
		const h = await serve([
			{ model: "deepseek-flash", choices: [{ delta: { content: "Hello" }, finish_reason: "stop" }] },
			final,
			final,
		]);
		const result = await h.run().result();
		expect(result.content).toEqual([{ type: "text", text: "Hello" }]);
		expect(result.responseModel).toBe("deepseek-flash");
		expect(result.usage).toMatchObject({ input: 15, output: 10, cacheRead: 80, cacheWrite: 5 });
		expect(h.ledger.snapshot()).toEqual({
			creditsCharged: 3,
			requests: 1,
			estimated: 0,
			unconfirmed: 0,
			models: ["deepseek-flash"],
		});
		expect(h.request()).toMatchObject({ stream: true, stream_options: { include_usage: true } });
	});
	it("never calls a missing or null receipt free", async () => {
		const h = await serve([{ choices: [{ delta: { content: "Hello" }, finish_reason: "stop" }] }]);
		await h.run().result();
		expect(formatBillingSummary(h.ledger.snapshot())).toBe("0 credits charged + 1 unconfirmed");
		expect(parseBillingReceipt({ credits_charged: null, usage_estimated: true }, "d4f")?.creditsCharged).toBeNull();
	});
	it("keeps the receipt sent before an interrupted-stream SDK error", async () => {
		const h = await serve([final, { error: { type: "provider_error", message: "upstream unavailable" } }]);
		expect((await h.run().result()).stopReason).toBe("error");
		expect(h.ledger.snapshot()).toMatchObject({ creditsCharged: 3, requests: 1, unconfirmed: 0 });
	});
	it("shows an admission denial without a retry or invented debit", async () => {
		const h = await serve([{ error: "insufficient_credits", error_description: "Not enough credits" }], 402);
		expect((await h.run().result()).stopReason).toBe("error");
		expect(h.ledger.snapshot()).toMatchObject({ creditsCharged: 0, requests: 1, unconfirmed: 1 });
	});
	it("keeps cancellation unconfirmed rather than zero-cost", async () => {
		const h = await serve([]);
		const controller = new AbortController();
		controller.abort();
		expect((await h.run(controller.signal).result()).stopReason).toBe("aborted");
		expect(h.ledger.snapshot().unconfirmed).toBe(1);
	});
	it("preserves SDK tool deltas", async () => {
		const h = await serve([
			{
				choices: [
					{
						delta: {
							tool_calls: [{ index: 0, id: "call1", function: { name: "write_file", arguments: '{"path":' } }],
						},
					},
				],
			},
			{
				choices: [
					{
						delta: { tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] },
						finish_reason: "tool_calls",
					},
				],
			},
			final,
		]);
		const result = await h.run().result();
		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toEqual([
			{ type: "toolCall", id: "call1", name: "write_file", arguments: { path: "a.txt" } },
		]);
	});
	it("rejects incomplete tool JSON without a completed tool event", async () => {
		const h = await serve([
			{
				choices: [
					{
						delta: {
							tool_calls: [{ index: 0, id: "call1", function: { name: "write_file", arguments: '{"path":' } }],
						},
						finish_reason: "length",
					},
				],
			},
			final,
		]);
		const events = [];
		for await (const event of h.run()) events.push(event);
		expect(events.some((event) => event.type === "toolcall_end")).toBe(false);
		expect(events.at(-1)?.type).toBe("error");
		expect(h.ledger.snapshot().requests).toBe(1);
	});
	it("never sends a Codebase key to a helper endpoint override", async () => {
		const h = await serve([]);
		const result = await h
			.stream({ ...h.model, baseUrl: "https://example.com/v1" }, { messages: [] }, { apiKey: "fake-key" })
			.result();
		expect(result.errorMessage).toContain("different endpoint");
		expect(h.request()).toBeUndefined();
	});
	it.each([-1, 0.5, Number.NaN, "3", undefined])("rejects invalid receipt amount %s", (value) => {
		expect(parseBillingReceipt({ credits_charged: value, usage_estimated: false }, "d4f")).toBeUndefined();
	});
});
