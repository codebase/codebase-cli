import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { stripRuntimeMarkup, visibleMessages } from "./visible-messages.js";

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
