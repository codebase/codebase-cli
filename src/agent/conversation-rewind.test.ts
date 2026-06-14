import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { listRewindPoints, truncateBefore } from "./conversation-rewind.js";

function user(text: string, timestamp = 0): AgentMessage {
	return { role: "user", content: text, timestamp };
}
function assistant(text: string): AgentMessage {
	return { role: "assistant", content: text, timestamp: 0 };
}
function toolResult(): AgentMessage {
	return {
		role: "user",
		content: [{ type: "tool_result", toolCallId: "x", content: [] }],
		timestamp: 0,
	} as AgentMessage;
}

describe("listRewindPoints", () => {
	it("returns one point per genuine user prompt, with index and preview", () => {
		const messages = [user("first prompt", 100), assistant("reply"), user("second prompt", 200), assistant("reply2")];
		const points = listRewindPoints(messages);
		expect(points).toEqual([
			{ index: 0, preview: "first prompt", timestamp: 100 },
			{ index: 2, preview: "second prompt", timestamp: 200 },
		]);
	});

	it("skips tool-result user messages and empty prompts", () => {
		const messages = [user("real prompt", 10), assistant("ran a tool"), toolResult(), assistant("done")];
		expect(listRewindPoints(messages).map((p) => p.index)).toEqual([0]);
	});

	it("strips system-reminders from the preview", () => {
		const messages = [user("<system-reminder>noise</system-reminder>actual question", 5)];
		expect(listRewindPoints(messages)[0].preview).toBe("actual question");
	});

	it("clips a long preview", () => {
		const long = "x".repeat(200);
		expect(listRewindPoints([user(long)])[0].preview.length).toBeLessThanOrEqual(80);
	});
});

describe("truncateBefore", () => {
	it("keeps everything before the rewind index", () => {
		const messages = [user("a"), assistant("b"), user("c"), assistant("d")];
		expect(truncateBefore(messages, 2)).toEqual([messages[0], messages[1]]);
	});

	it("returns an empty array when rewinding to the very first prompt", () => {
		const messages = [user("a"), assistant("b")];
		expect(truncateBefore(messages, 0)).toEqual([]);
	});
});
