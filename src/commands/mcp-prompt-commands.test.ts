import { describe, expect, it } from "vitest";
import { flattenPromptMessages, mcpPromptCommandName, parseArgs } from "./mcp-prompt-commands.js";

describe("mcpPromptCommandName", () => {
	it("namespaces server + prompt", () => {
		expect(mcpPromptCommandName("git", "changelog")).toBe("mcp__git__changelog");
	});
});

describe("parseArgs", () => {
	const declared = [{ name: "topic" }, { name: "tone" }];

	it("parses key=value pairs", () => {
		expect(parseArgs("topic=auth tone=terse", declared)).toEqual({ topic: "auth", tone: "terse" });
	});

	it("maps positional args, last arg soaks the rest", () => {
		expect(parseArgs("auth be very terse", declared)).toEqual({ topic: "auth", tone: "be very terse" });
	});

	it("puts a single arg in the first declared slot", () => {
		expect(parseArgs("auth", declared)).toEqual({ topic: "auth" });
	});

	it("falls back to {input} when nothing is declared", () => {
		expect(parseArgs("whatever they typed", undefined)).toEqual({ input: "whatever they typed" });
	});

	it("returns {} for empty args", () => {
		expect(parseArgs("  ", declared)).toEqual({});
	});
});

describe("flattenPromptMessages", () => {
	it("joins user messages plainly and labels other roles", () => {
		const text = flattenPromptMessages([
			{ role: "user", content: "do the thing" },
			{ role: "assistant", content: { type: "text", text: "context" } },
		]);
		expect(text).toBe("do the thing\n\n[assistant]\ncontext");
	});

	it("flattens content-block arrays", () => {
		const text = flattenPromptMessages([
			{
				role: "user",
				content: [
					{ type: "text", text: "a" },
					{ type: "text", text: "b" },
				],
			},
		]);
		expect(text).toBe("a\nb");
	});

	it("returns empty for missing messages", () => {
		expect(flattenPromptMessages(undefined)).toBe("");
	});
});
