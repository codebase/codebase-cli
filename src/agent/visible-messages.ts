import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { stripDsmlProtocol } from "./safe-stream.js";

/** Remove runtime-only scaffolding from text shown outside the model context. */
export function stripRuntimeMarkup(text: string): string {
	return stripDsmlProtocol(text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "")).trim();
}

/**
 * Produce a user-facing transcript. Internal reminders and thinking stay in
 * model/session state, while historical proxy protocol and duplicate calls do
 * not reappear in resume screens or JSON output.
 */
export function visibleMessages(messages: AgentMessage[]): AgentMessage[] {
	const out: AgentMessage[] = [];
	const hiddenToolResults = new Set<string>();

	for (const message of messages) {
		if (message.role === "user") {
			if (typeof message.content === "string") {
				const content = stripRuntimeMarkup(message.content);
				if (content) out.push({ ...message, content });
				continue;
			}
			const content: typeof message.content = [];
			for (const block of message.content) {
				if (block.type !== "text") {
					content.push(block);
					continue;
				}
				const text = stripRuntimeMarkup(block.text);
				if (text) content.push({ ...block, text });
			}
			if (content.length > 0) out.push({ ...message, content });
			continue;
		}

		if (message.role === "assistant") {
			const seen = new Set<string>();
			const content: typeof message.content = [];
			for (const block of message.content) {
				if (block.type === "thinking") continue;
				if (block.type === "text") {
					const text = stripRuntimeMarkup(block.text);
					if (text) content.push({ ...block, text });
					continue;
				}
				if (block.type === "toolCall") {
					const fingerprint = `${block.name}:${stableJson(block.arguments)}`;
					if (seen.has(fingerprint)) {
						hiddenToolResults.add(block.id);
						continue;
					}
					seen.add(fingerprint);
				}
				content.push(block);
			}
			if (content.length > 0 || message.errorMessage) out.push({ ...message, content });
			continue;
		}

		if (!hiddenToolResults.has(message.toolCallId)) out.push(message);
	}

	return out;
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
