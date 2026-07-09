import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	streamSimple,
} from "@earendil-works/pi-ai";

const DSML_MARKER = "<|dsml|";
export const DEFAULT_PROXY_RESPONSE_TIMEOUT_MS = 90_000;

/** Remove textual proxy protocol that must never be rendered or re-parsed. */
export function stripDsmlProtocol(text: string): string {
	const normalized = text.toLowerCase().replaceAll("｜", "|");
	const fullMarker = normalized.indexOf(DSML_MARKER);
	if (fullMarker >= 0) return text.slice(0, fullMarker).trimEnd();

	// Streaming can split the marker across chunks. Hide a trailing partial
	// marker as soon as it starts instead of flashing protocol in the TUI.
	for (let i = normalized.lastIndexOf("<"); i >= 0; i = normalized.lastIndexOf("<", i - 1)) {
		const suffix = normalized.slice(i);
		if (DSML_MARKER.startsWith(suffix)) return text.slice(0, i).trimEnd();
	}
	return text;
}

/** Normalize a proxy response before pi-agent-core can execute its tools. */
export function sanitizeAssistantMessage(message: AssistantMessage): AssistantMessage {
	const seenToolCalls = new Set<string>();
	const content: AssistantMessage["content"] = [];
	for (const block of message.content) {
		if (block.type === "text") {
			const text = stripDsmlProtocol(block.text);
			if (text) content.push({ ...block, text });
			continue;
		}
		if (block.type === "toolCall") {
			const fingerprint = `${block.name}:${stableJson(block.arguments)}`;
			if (seenToolCalls.has(fingerprint)) continue;
			seenToolCalls.add(fingerprint);
		}
		content.push(block);
	}
	return { ...message, content };
}

/**
 * Proxy models occasionally return both native tool calls and a textual DSML
 * copy, and have also repeated an identical native call in one response. This
 * wrapper cleans every partial snapshot plus the final message so the UI and
 * executor see the same safe response.
 */
export function streamProxySafely(...args: Parameters<typeof streamSimple>): ReturnType<typeof streamSimple> {
	const [model, context, options] = args;
	const output = createAssistantMessageEventStream();
	const controller = new AbortController();
	const parentSignal = options?.signal;
	let latest = emptyAssistantMessage(model);
	let timedOut = false;

	const abortFromParent = () => controller.abort(parentSignal?.reason);
	if (parentSignal?.aborted) abortFromParent();
	else parentSignal?.addEventListener("abort", abortFromParent, { once: true });

	const timeoutMs = proxyResponseTimeoutMs();
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
		output.push({
			type: "error",
			reason: "error",
			error: failedAssistantMessage(
				latest,
				"error",
				`Model response exceeded ${Math.round(timeoutMs / 1000)}s and was stopped. Retry with a narrower request or start a fresh session.`,
			),
		});
	}, timeoutMs);
	timer.unref?.();

	const upstream = streamSimple(model, context, { ...options, signal: controller.signal });
	void (async () => {
		try {
			for await (const event of upstream) {
				const sanitized = sanitizeEvent(event);
				latest = messageFromEvent(sanitized);
				output.push(sanitized);
			}
		} catch (error) {
			if (timedOut) return;
			output.push({
				type: "error",
				reason: controller.signal.aborted ? "aborted" : "error",
				error: failedAssistantMessage(
					latest,
					controller.signal.aborted ? "aborted" : "error",
					error instanceof Error ? error.message : String(error),
				),
			});
		}
	})();
	void output.result().finally(() => {
		clearTimeout(timer);
		parentSignal?.removeEventListener("abort", abortFromParent);
	});
	return output;
}

export function sanitizeAssistantStream(upstream: AssistantMessageEventStream): AssistantMessageEventStream {
	const output = createAssistantMessageEventStream();
	void (async () => {
		for await (const event of upstream) output.push(sanitizeEvent(event));
	})();
	return output;
}

function sanitizeEvent(event: AssistantMessageEvent): AssistantMessageEvent {
	if (event.type === "done") return { ...event, message: sanitizeAssistantMessage(event.message) };
	if (event.type === "error") return { ...event, error: sanitizeAssistantMessage(event.error) };
	return { ...event, partial: sanitizeAssistantMessage(event.partial) };
}

export function proxyResponseTimeoutMs(value = process.env.CODEBASE_RESPONSE_TIMEOUT_MS): number {
	if (value === undefined || value.trim() === "") return DEFAULT_PROXY_RESPONSE_TIMEOUT_MS;
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return DEFAULT_PROXY_RESPONSE_TIMEOUT_MS;
	return Math.max(10_000, Math.min(600_000, Math.round(parsed)));
}

function messageFromEvent(event: AssistantMessageEvent): AssistantMessage {
	if (event.type === "done") return event.message;
	if (event.type === "error") return event.error;
	return event.partial;
}

function emptyAssistantMessage(model: Parameters<typeof streamSimple>[0]): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function failedAssistantMessage(
	message: AssistantMessage,
	stopReason: "aborted" | "error",
	errorMessage: string,
): AssistantMessage {
	const sanitized = sanitizeAssistantMessage(message);
	return {
		...sanitized,
		// A partially streamed tool call was never executed. Do not persist or
		// render it as a completed action after timeout/abort.
		content: sanitized.content.filter((block) => block.type !== "toolCall"),
		stopReason,
		errorMessage,
	};
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? String(value);
}
