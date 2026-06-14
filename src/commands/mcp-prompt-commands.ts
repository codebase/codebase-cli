import type { McpManager, McpPromptRef } from "../mcp/manager.js";
import type { McpContentBlock } from "../mcp/protocol.js";
import type { CommandRegistry } from "./registry.js";
import type { Command } from "./types.js";

/** MCP prompt → slash command name: `mcp__<server>__<prompt>`, mirroring tool naming. */
export function mcpPromptCommandName(server: string, prompt: string): string {
	return `mcp__${server}__${prompt}`;
}

const VALID = /^[a-z0-9][a-z0-9_-]*$/i;

/**
 * Bridge connected MCP prompts into slash commands. `/mcp__<server>__<name>
 * [args]` calls prompts/get on the server, flattens the returned messages
 * into a single prompt, and submits it to the agent. Arguments are parsed
 * positionally against the prompt's declared `arguments`, or as
 * `key=value` pairs. Names that collide with a built-in or are unsafe for
 * a command are skipped.
 */
export function buildMcpPromptCommands(
	prompts: readonly McpPromptRef[],
	mcp: McpManager,
	registry: CommandRegistry,
): Command[] {
	const out: Command[] = [];
	for (const { server, descriptor } of prompts) {
		const name = mcpPromptCommandName(server, descriptor.name);
		if (!VALID.test(name) || registry.get(name)) continue;
		out.push({
			name,
			description: descriptor.description
				? `${descriptor.description} (MCP prompt)`
				: `MCP prompt ${descriptor.name}.`,
			handler: (args, ctx) => {
				if (ctx.state.status !== "idle" && ctx.state.status !== "error" && ctx.state.status !== "aborted") {
					ctx.emit(`agent is busy — run /${name} after this turn settles.`);
					return { handled: true };
				}
				const parsed = parseArgs(args, descriptor.arguments);
				void mcp
					.getPrompt(server, descriptor.name, parsed)
					.then((result) => {
						const text = flattenPromptMessages(result.messages);
						if (!text.trim()) {
							ctx.emit(`MCP prompt "${descriptor.name}" returned nothing.`);
							return;
						}
						return ctx.bundle.submitUserPrompt(text).then((r) => {
							if (!r.submitted) ctx.emit(`prompt blocked: ${r.reason ?? "refused by hook"}`);
							else if (r.error) ctx.emit(`agent error: ${r.error}`);
						});
					})
					.catch((err) => ctx.emit(`MCP prompt failed: ${err instanceof Error ? err.message : String(err)}`));
				return { handled: true };
			},
		});
	}
	return out;
}

/** Map user args to the prompt's declared arguments — `key=value` pairs first, else positional. */
export function parseArgs(raw: string, declared: McpPromptRef["descriptor"]["arguments"]): Record<string, string> {
	const trimmed = raw.trim();
	if (!trimmed) return {};
	const tokens = trimmed.split(/\s+/);
	const names = (declared ?? []).map((a) => a.name);

	// All tokens look like key=value → keyed.
	if (tokens.every((t) => /^[^=\s]+=/.test(t))) {
		const out: Record<string, string> = {};
		for (const t of tokens) {
			const eq = t.indexOf("=");
			out[t.slice(0, eq)] = t.slice(eq + 1);
		}
		return out;
	}

	// Positional against declared names; a single undeclared arg → first slot.
	if (names.length === 0) return { input: trimmed };
	const out: Record<string, string> = {};
	names.forEach((n, i) => {
		if (i < names.length - 1) {
			if (tokens[i] !== undefined) out[n] = tokens[i];
		} else {
			// Last declared arg soaks up the remaining tokens.
			const rest = tokens.slice(i).join(" ");
			if (rest) out[n] = rest;
		}
	});
	return out;
}

/** Flatten prompt messages into a single text prompt; non-user roles are labeled. */
export function flattenPromptMessages(
	messages: Array<{ role: string; content: string | McpContentBlock | McpContentBlock[] }> | undefined,
): string {
	if (!Array.isArray(messages)) return "";
	const parts: string[] = [];
	for (const m of messages) {
		const text = contentToText(m.content);
		if (!text) continue;
		parts.push(m.role === "user" ? text : `[${m.role}]\n${text}`);
	}
	return parts.join("\n\n");
}

function contentToText(content: string | McpContentBlock | McpContentBlock[]): string {
	if (typeof content === "string") return content;
	const blocks = Array.isArray(content) ? content : [content];
	return blocks
		.map((b) => (b.type === "text" && typeof b.text === "string" ? b.text : `[${b.type} content]`))
		.join("\n");
}
