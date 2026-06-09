import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { capToolResult } from "./cap-tool-result.js";

function fakeTool(name: string, result: AgentToolResult<unknown>): AgentTool<any> {
	return {
		name,
		label: name,
		description: "",
		// biome-ignore lint/suspicious/noExplicitAny: minimal schema stub for the test.
		parameters: { type: "object", properties: {} } as any,
		execute: async () => result,
	};
}

function textResult(text: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details: {} };
}

describe("capToolResult", () => {
	it("passes small results through untouched", async () => {
		const wrapped = capToolResult(fakeTool("grep", textResult("short output")));
		const out = await wrapped.execute("tc1", {}, undefined, undefined);
		expect(out.content).toEqual([{ type: "text", text: "short output" }]);
	});

	it("spills an oversized result to disk and replaces it with a preview", async () => {
		const big = "x".repeat(60_000);
		const wrapped = capToolResult(fakeTool("grep", textResult(big)), 50_000);
		const out = await wrapped.execute("tc2", {}, undefined, undefined);
		expect(out.content).toHaveLength(1);
		const block = out.content[0];
		expect(block.type).toBe("text");
		if (block.type !== "text") return;
		expect(block.text).toMatch(/Output too large for context: 60000 chars/);
		expect(block.text).toMatch(/Full result saved to:/);
		// Preview present, but the full 60k is NOT inline.
		expect(block.text.length).toBeLessThan(5_000);
		// The spill file exists and contains the full text.
		const pathMatch = block.text.match(/saved to:\n {2}(\S+)/);
		expect(pathMatch).not.toBeNull();
		if (pathMatch) {
			const saved = readFileSync(pathMatch[1], "utf8");
			expect(saved).toBe(big);
		}
	});

	it("respects a custom maxChars threshold", async () => {
		const wrapped = capToolResult(fakeTool("grep", textResult("y".repeat(200))), 100);
		const out = await wrapped.execute("tc3", {}, undefined, undefined);
		expect(out.content[0].type).toBe("text");
		if (out.content[0].type === "text") {
			expect(out.content[0].text).toMatch(/Output too large/);
		}
	});

	it("leaves self-capped tools (shell, ssh_exec, dispatch_agent) unwrapped", async () => {
		const big = "z".repeat(80_000);
		const shell = fakeTool("shell", textResult(big));
		const wrapped = capToolResult(shell);
		// Same object reference back — no wrapping applied.
		expect(wrapped).toBe(shell);
		const out = await wrapped.execute("tc4", {}, undefined, undefined);
		expect(out.content[0]).toEqual({ type: "text", text: big });
	});

	it("preserves image blocks and only caps text", async () => {
		const result: AgentToolResult<unknown> = {
			content: [
				{ type: "image", data: "BASE64", mimeType: "image/png" },
				{ type: "text", text: "w".repeat(60_000) },
			],
			details: {},
		};
		const wrapped = capToolResult(fakeTool("read_file", result), 50_000);
		const out = await wrapped.execute("tc5", {}, undefined, undefined);
		// Image first, then the collapsed text notice.
		expect(out.content[0].type).toBe("image");
		expect(out.content[1].type).toBe("text");
	});
});
