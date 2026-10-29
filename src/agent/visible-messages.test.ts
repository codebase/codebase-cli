import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { recentMessages, stripRuntimeMarkup, visibleMessages } from "./visible-messages.js";

describe("stripRuntimeMarkup", () => {
	it("removes system reminders and DSML framing", () => {
		expect(
			stripRuntimeMarkup("<system-reminder>internal receipt rules</system-reminder>Actual prompt<｜DSML｜bad"),
		).toBe("Actual prompt");
	});
});

describe("visibleMessages", () => {
	it("hides thinking plus duplicate calls and their results", () => {
		const messages = [
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "private repair narration" },
					{ type: "toolCall", id: "a", name: "shell", arguments: { command: "npm test" } },
					{ type: "toolCall", id: "b", name: "shell", arguments: { command: "npm test" } },
				],
			},
			{ role: "toolResult", toolCallId: "a", toolName: "shell", content: [], isError: false },
			{ role: "toolResult", toolCallId: "b", toolName: "shell", content: [], isError: false },
		] as AgentMessage[];

		const visible = visibleMessages(messages);
		expect(visible).toHaveLength(2);
		expect(visible[0]?.role).toBe("assistant");
		expect(visible[1]).toMatchObject({ role: "toolResult", toolCallId: "a" });
	});
});

describe("recentMessages", () => {
	const user = (n: number) => ({ role: "user", content: `u${n}`, timestamp: n }) as AgentMessage;
	const tool = (n: number): AgentMessage => ({
		role: "toolResult",
		toolCallId: `t${n}`,
		toolName: "read_file",
		content: [],
		isError: false,
		timestamp: n,
	});

	it("returns everything under the limit", () => {
		const msgs = [user(1), tool(2)];
		expect(recentMessages(msgs, 5)).toBe(msgs);
	});

	it("starts the cut at a user turn so it never opens on a tool result", () => {
		const msgs = [user(1), tool(2), tool(3), user(4), tool(5)];
		expect(recentMessages(msgs, 3).map((m) => m.timestamp)).toEqual([4, 5]);
	});

	it("falls back to the plain cut when one turn exceeds the limit", () => {
		const msgs = [user(1), tool(2), tool(3), tool(4)];
		expect(recentMessages(msgs, 2).map((m) => m.timestamp)).toEqual([3, 4]);
	});
});
