import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	parseStreamingJson,
	type SimpleStreamOptions,
	type StreamFunction,
	type ToolCall,
} from "@earendil-works/pi-ai";
import { convertMessages } from "@earendil-works/pi-ai/openai-completions";
import OpenAI from "openai";
import type { ChatCompletionChunk, ChatCompletionCreateParamsStreaming } from "openai/resources/chat/completions.js";
import { type BillingLedger, type BillingReceipt, parseBillingReceipt } from "./codebase-billing.js";

// Codebase normalizes every upstream to Chat Completions. Keep pi's message
// conversion and the official SDK's SSE parser; only the billing extension is ours.
const COMPAT = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: true,
	supportsUsageInStreaming: true,
	maxTokensField: "max_tokens" as const,
	requiresToolResultName: true,
	requiresAssistantAfterToolResult: false,
	requiresThinkingAsText: false,
	requiresReasoningContentOnAssistantMessages: false,
	thinkingFormat: "openai" as const,
	openRouterRouting: {},
	vercelGatewayRouting: {},
	zaiToolStream: false,
	supportsStrictMode: false,
	sendSessionAffinityHeaders: false,
	supportsLongCacheRetention: false,
};

type BillingChunk = ChatCompletionChunk & { codebase_billing?: unknown };
type BilledMessage = AssistantMessage & { codebaseBilling?: BillingReceipt };

export function createCodebaseStream(
	ledger: BillingLedger,
	baseUrl: string,
): StreamFunction<string, SimpleStreamOptions> {
	return (model, context, options = {}) => {
		const stream = createAssistantMessageEventStream();
		const output: BilledMessage = {
			role: "assistant",
			api: "openai-completions",
			provider: model.provider,
			model: model.id,
			content: [],
			stopReason: "stop",
			timestamp: Date.now(),
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		void (async () => {
			let receipt: BillingReceipt | undefined;
			let recorded = false;
			const tools = new Map<number, { block: ToolCall; args: string }>();
			try {
				if (!model.baseUrl || new URL(model.baseUrl).href !== new URL(baseUrl).href)
					throw new Error("Codebase credentials cannot be used with a different endpoint.");
				const client = new OpenAI({
					apiKey: options.apiKey,
					baseURL: model.baseUrl,
					maxRetries: 0,
					timeout: options.timeoutMs ?? 600_000,
					defaultHeaders: { ...model.headers, ...options.headers },
				});
				const chatModel = { ...model, api: "openai-completions", reasoning: false } as Model<"openai-completions">;
				let payload: ChatCompletionCreateParamsStreaming = {
					model: model.id,
					messages: convertMessages(chatModel, context, COMPAT),
					stream: true,
					stream_options: { include_usage: true },
					max_tokens: Math.min(options.maxTokens ?? model.maxTokens, model.maxTokens),
					...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
					...(context.tools?.length
						? {
								tools: context.tools.map((tool) => ({
									type: "function" as const,
									function: {
										name: tool.name,
										description: tool.description,
										parameters: tool.parameters as unknown as Record<string, unknown>,
									},
								})),
							}
						: {}),
				};
				const replacement = await options.onPayload?.(payload, model);
				if (replacement !== undefined) payload = replacement as ChatCompletionCreateParamsStreaming;
				const { data, response } = await client.chat.completions
					.create(payload, { signal: options.signal })
					.withResponse();
				await options.onResponse?.(
					{ status: response.status, headers: Object.fromEntries(response.headers) },
					model,
				);
				stream.push({ type: "start", partial: output });
				for await (const raw of data) {
					const chunk = raw as BillingChunk;
					if (chunk.model) output.responseModel = chunk.model;
					output.responseId ||= chunk.id;
					const parsed = parseBillingReceipt(
						chunk.codebase_billing,
						chunk.model || output.responseModel || model.id,
					);
					if (parsed) receipt = parsed;
					if (chunk.usage) {
						const cached = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
						const writes =
							(chunk.usage.prompt_tokens_details as { cache_write_tokens?: number } | undefined)
								?.cache_write_tokens ?? 0;
						output.usage.input = Math.max(0, chunk.usage.prompt_tokens - cached - writes);
						output.usage.output = chunk.usage.completion_tokens;
						output.usage.cacheRead = cached;
						output.usage.cacheWrite = writes;
						output.usage.totalTokens = chunk.usage.total_tokens;
					}
					const choice = chunk.choices?.[0];
					if (!choice) continue;
					if (choice.finish_reason === "tool_calls") output.stopReason = "toolUse";
					else if (choice.finish_reason === "length") output.stopReason = "length";
					else if (choice.finish_reason === "content_filter")
						throw new Error("The provider refused this response.");
					const delta = choice.delta;
					if (delta.content) appendText("text", delta.content);
					const reasoning = delta as typeof delta & { reasoning_content?: string; reasoning?: string };
					if (reasoning.reasoning_content || reasoning.reasoning)
						appendText("thinking", reasoning.reasoning_content || reasoning.reasoning || "");
					for (const call of delta.tool_calls ?? []) {
						let entry = tools.get(call.index);
						if (!entry) {
							entry = {
								block: { type: "toolCall", id: call.id || "", name: call.function?.name || "", arguments: {} },
								args: "",
							};
							tools.set(call.index, entry);
							output.content.push(entry.block);
							stream.push({
								type: "toolcall_start",
								contentIndex: output.content.indexOf(entry.block),
								partial: output,
							});
						}
						if (call.id) entry.block.id = call.id;
						if (call.function?.name) entry.block.name = call.function.name;
						entry.args += call.function?.arguments || "";
						entry.block.arguments = parseStreamingJson(entry.args);
						stream.push({
							type: "toolcall_delta",
							contentIndex: output.content.indexOf(entry.block),
							delta: call.function?.arguments || "",
							partial: output,
						});
					}
				}
				if (options.signal?.aborted) throw new Error("Request cancelled");
				for (const [contentIndex, block] of output.content.entries()) {
					if (block.type === "toolCall") {
						const entry = [...tools.values()].find((candidate) => candidate.block === block);
						block.arguments = JSON.parse(entry?.args || "{}");
						stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: output });
					} else if (block.type === "text")
						stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
					else if (block.type === "thinking")
						stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: output });
				}
				finishBilling();
				stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
			} catch (error) {
				const data =
					error instanceof OpenAI.APIError ? (error.error as Record<string, unknown> | undefined) : undefined;
				receipt = parseBillingReceipt(data?.codebase_billing, output.responseModel || model.id) ?? receipt;
				output.stopReason = options.signal?.aborted ? "aborted" : "error";
				output.errorMessage = options.signal?.aborted
					? "Request cancelled; check Usage for its final charge."
					: error instanceof Error
						? error.message
						: "Inference request failed";
				finishBilling();
				stream.push({ type: "error", reason: output.stopReason, error: output });
			} finally {
				stream.end();
			}

			function finishBilling(): void {
				if (recorded) return;
				recorded = true;
				output.codebaseBilling = receipt ?? {
					creditsCharged: null,
					usageEstimated: false,
					model: output.responseModel || model.id,
				};
				ledger.record(output.codebaseBilling);
			}
			function appendText(kind: "text" | "thinking", text: string): void {
				let block = output.content.at(-1);
				if (!block || block.type !== kind) {
					block = kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" };
					output.content.push(block);
					stream.push({
						type: kind === "text" ? "text_start" : "thinking_start",
						contentIndex: output.content.length - 1,
						partial: output,
					});
				}
				if (block.type === "text") block.text += text;
				else if (block.type === "thinking") block.thinking += text;
				stream.push({
					type: kind === "text" ? "text_delta" : "thinking_delta",
					contentIndex: output.content.length - 1,
					delta: text,
					partial: output,
				});
			}
		})();
		return stream;
	};
}
