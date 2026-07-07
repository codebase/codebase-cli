import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Context,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	registerFauxProvider,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgent } from "../agent.js";

/**
 * End-to-end coverage of our agent bundle wiring. Pi-mono already tests
 * the bare loop with its own e2e suite; this test exists to catch
 * regressions in OUR layer: the bundle composition, tool dispatch
 * through our buildTools, message persistence, hook lifecycle, and
 * (most importantly) that the streaming-events → reducer pipeline our
 * App.tsx depends on doesn't silently drop anything.
 *
 * Uses pi-ai's built-in `registerFauxProvider`, which is exported from
 * the npm package we already depend on. No new mock infrastructure.
 */

describe("agent bundle end-to-end", () => {
	let cwd: string;
	let home: string;
	let prevHome: string | undefined;
	let prevNoAutoMemory: string | undefined;
	let faux: FauxProviderRegistration;

	beforeEach(() => {
		prevHome = process.env.HOME;
		prevNoAutoMemory = process.env.CODEBASE_NO_AUTO_MEMORY;
		home = mkdtempSync(join(tmpdir(), "codebase-e2e-home-"));
		process.env.HOME = home;
		process.env.CODEBASE_NO_AUTO_MEMORY = "1";

		cwd = mkdtempSync(join(tmpdir(), "codebase-e2e-"));
		// Seed a file the agent's first scripted tool call will read.
		writeFileSync(join(cwd, "hello.txt"), "hello from the e2e harness\n");
		faux = registerFauxProvider({
			provider: "faux",
			models: [{ id: "faux-model", name: "Faux Model" }],
		});
	});

	afterEach(() => {
		faux.unregister();
		rmSync(cwd, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
		if (prevHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevHome;
		if (prevNoAutoMemory === undefined) delete process.env.CODEBASE_NO_AUTO_MEMORY;
		else process.env.CODEBASE_NO_AUTO_MEMORY = prevNoAutoMemory;
	});

	it("runs a tool call and produces a final answer", async () => {
		// Turn 1: assistant says "let me check" and calls read_file.
		// Turn 2: assistant produces the final answer using the tool result.
		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxText("Let me read that file."),
					fauxToolCall("read_file", { path: join(cwd, "hello.txt") }, { id: "call-1" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("The file says: hello from the e2e harness."),
		]);

		const bundle = createAgent({
			cwd,
			configOverride: { model: faux.getModel(), apiKey: "test-key", source: "explicit" },
			autoApprove: true,
		});

		const events: string[] = [];
		bundle.subscribe((event) => {
			events.push(event.type);
		});

		await bundle.agent.prompt("Read hello.txt and summarize.");

		// Final state: user prompt → assistant w/ tool call → tool result → assistant answer.
		expect(bundle.agent.state.messages.length).toBe(4);
		expect(bundle.agent.state.messages[0].role).toBe("user");
		expect(bundle.agent.state.messages[1].role).toBe("assistant");
		expect(bundle.agent.state.messages[2].role).toBe("toolResult");
		expect(bundle.agent.state.messages[3].role).toBe("assistant");

		const toolResult = bundle.agent.state.messages[2];
		if (toolResult.role !== "toolResult") throw new Error("expected toolResult");
		expect(toolResult.toolName).toBe("read_file");
		const resultText = toolResult.content.map((b) => (b.type === "text" ? b.text : "")).join("");
		expect(resultText).toContain("hello from the e2e harness");

		// Lifecycle events fired in expected order (we don't assert on
		// every event, just the load-bearing ones).
		expect(events).toContain("agent_start");
		expect(events).toContain("message_start");
		expect(events).toContain("message_end");
		expect(events).toContain("tool_execution_start");
		expect(events).toContain("tool_execution_end");
		expect(events).toContain("agent_end");

		// Tool-execution events bracket the call cleanly.
		const toolStart = events.indexOf("tool_execution_start");
		const toolEnd = events.indexOf("tool_execution_end");
		expect(toolStart).toBeGreaterThan(-1);
		expect(toolEnd).toBeGreaterThan(toolStart);

		// Faux provider was called twice (one per assistant turn).
		expect(faux.state.callCount).toBe(2);
	});

	it("session persists after a completed turn", async () => {
		faux.setResponses([fauxAssistantMessage("hello back")]);
		const bundle = createAgent({
			cwd,
			configOverride: { model: faux.getModel(), apiKey: "test-key", source: "explicit" },
			autoApprove: true,
		});

		await bundle.agent.prompt("hi");

		// Session file should exist now and have both messages.
		const stored = bundle.sessions.load(faux.getModel().id);
		expect(stored).not.toBeNull();
		if (!stored) return;
		expect(stored.messages.length).toBe(2);
		expect(stored.messages[0].role).toBe("user");
		expect(stored.messages[1].role).toBe("assistant");
	});

	it("compaction monitor stays inactive when transcript is short", async () => {
		faux.setResponses([fauxAssistantMessage("short reply")]);
		const bundle = createAgent({
			cwd,
			configOverride: { model: faux.getModel(), apiKey: "test-key", source: "explicit" },
			autoApprove: true,
		});

		expect(bundle.compactionMonitor.current().active).toBe(false);
		await bundle.agent.prompt("hi");
		// Short transcript can't trigger compaction; monitor must stay idle.
		expect(bundle.compactionMonitor.current().active).toBe(false);
	});

	it("recalls relevant memory for the model without persisting reminder messages", async () => {
		let seenContext: Context | null = null;
		faux.setResponses([
			(context) => {
				seenContext = { ...context, messages: structuredClone(context.messages), tools: [] };
				return fauxAssistantMessage("Use the orchard checklist.");
			},
		]);
		const bundle = createAgent({
			cwd,
			configOverride: { model: faux.getModel(), apiKey: "test-key", source: "explicit" },
			autoApprove: true,
		});
		bundle.memory.save({
			filename: "orchard_deploy.md",
			name: "Orchard deploy checklist",
			description: "Required steps for orchard deploy tasks",
			type: "project",
			body: "Run npm run check and capture the preview URL before calling orchard done.",
		});
		bundle.memory.save({
			filename: "palette.md",
			name: "Palette note",
			description: "Brand color reference",
			type: "reference",
			body: "Use green for success and red for destructive actions.",
		});

		const result = await bundle.submitUserPrompt("Please handle the orchard deploy now.");

		expect(result).toEqual({ submitted: true });
		expect(seenContext).not.toBeNull();
		const userTexts = userTextsFromContext(seenContext!);
		expect(userTexts[0]).toContain("<system-reminder>");
		expect(userTexts[0]).toContain("Relevant project memories for this prompt");
		expect(userTexts[0]).toContain("file: orchard_deploy.md; type: project; source: local project memory");
		expect(userTexts[0]).toContain("Run npm run check");
		expect(userTexts[0]).not.toContain("Palette note");
		expect(userTexts[1]).toContain("Please handle the orchard deploy now.");

		expect(bundle.agent.state.messages).toHaveLength(2);
		expect(userTextsFromContext({ messages: bundle.agent.state.messages, tools: [] })).toEqual([
			"Please handle the orchard deploy now.",
		]);
	});
});

function userTextsFromContext(context: Pick<Context, "messages">): string[] {
	return context.messages.flatMap((message) => (message.role === "user" ? [messageContentText(message.content)] : []));
}

function messageContentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((block) => {
			if (!block || typeof block !== "object") return [];
			const candidate = block as { type?: unknown; text?: unknown };
			return candidate.type === "text" && typeof candidate.text === "string" ? [candidate.text] : [];
		})
		.join("\n");
}
