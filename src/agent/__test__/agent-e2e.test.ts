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

	it("session keeps every turn, not just the latest run", async () => {
		faux.setResponses([fauxAssistantMessage("first reply"), fauxAssistantMessage("second reply")]);
		const opts = {
			cwd,
			configOverride: { model: faux.getModel(), apiKey: "test-key", source: "explicit" as const },
			autoApprove: true,
		};
		const bundle = createAgent(opts);
		await bundle.agent.prompt("one");
		await bundle.agent.prompt("two");
		expect(bundle.sessions.load(faux.getModel().id)?.messages).toHaveLength(4);

		// A resumed session keeps its history when the next turn saves.
		faux.setResponses([fauxAssistantMessage("third reply")]);
		const resumed = createAgent({ ...opts, resume: true });
		expect(resumed.resumedMessages).toHaveLength(4);
		await resumed.agent.prompt("three");
		expect(resumed.sessions.load(faux.getModel().id)?.messages).toHaveLength(6);
	});

	it("compacts once per threshold crossing, not on every later request", async () => {
		faux.unregister();
		faux = registerFauxProvider({
			provider: "faux",
			models: [{ id: "faux-small", name: "Faux Small", contextWindow: 20_270 }],
		});
		const firstMessages: string[] = [];
		faux.setResponses(
			Array.from({ length: 60 }, () => (context: Context) => {
				const first = context.messages[0];
				firstMessages.push(typeof first?.content === "string" ? first.content : JSON.stringify(first?.content));
				return fauxAssistantMessage("ok");
			}),
		);
		const opts = {
			cwd,
			configOverride: { model: faux.getModel(), apiKey: "test-key", source: "explicit" as const },
			autoApprove: true,
		};
		const bundle = createAgent(opts);
		let compactions = 0;
		bundle.compactionMonitor.subscribe((s) => {
			if (s.active) compactions++;
		});

		for (let i = 0; i < 10; i++) await bundle.agent.prompt(`big ${i} ${"x ".repeat(300)}`);
		const afterCrossing = compactions;
		for (let i = 0; i < 4; i++) await bundle.agent.prompt(`small ${i}`);

		expect(afterCrossing).toBe(1);
		expect(compactions).toBe(afterCrossing);

		// After a restart the saved summary is reused: no new compaction, and
		// the first request already starts from the summary, not the full history.
		const resumed = createAgent({ ...opts, resume: true });
		let resumedCompactions = 0;
		resumed.compactionMonitor.subscribe((s) => {
			if (s.active) resumedCompactions++;
		});
		firstMessages.length = 0;
		await resumed.agent.prompt("after restart");
		expect(resumedCompactions).toBe(0);
		expect(firstMessages[0]).toContain("[Conversation compacted");
	});

	it("never caches a failed summary: keeps full context, retries, and resumes clean", async () => {
		faux.unregister();
		faux = registerFauxProvider({
			provider: "faux",
			models: [{ id: "faux-small", name: "Faux Small", contextWindow: 20_270 }],
		});
		const firstMessages: string[] = [];
		let summaryCalls = 0;
		faux.setResponses(
			Array.from({ length: 80 }, () => (context: Context) => {
				if (context.systemPrompt?.startsWith("Summarize the prior conversation")) {
					summaryCalls++;
					throw new Error("summarizer down");
				}
				const first = context.messages[0];
				firstMessages.push(typeof first?.content === "string" ? first.content : JSON.stringify(first?.content));
				return fauxAssistantMessage("ok");
			}),
		);
		const opts = {
			cwd,
			configOverride: { model: faux.getModel(), apiKey: "test-key", source: "explicit" as const },
			autoApprove: true,
		};
		const bundle = createAgent(opts);
		for (let i = 0; i < 10; i++) await bundle.agent.prompt(`big ${i} ${"x ".repeat(300)}`);
		const failedAttempts = summaryCalls;
		await bundle.agent.prompt("small after failure");

		expect(failedAttempts).toBeGreaterThan(0);
		// Not memoized, so the next request tries again instead of trusting the failure.
		expect(summaryCalls).toBeGreaterThan(failedAttempts);
		// The full context (earliest user constraint included) was still sent.
		expect(firstMessages.at(-1)).toContain("big 0");
		expect(firstMessages.some((m) => m.includes("summarization failed"))).toBe(false);

		const saved = bundle.sessions.load(faux.getModel().id);
		expect(saved?.compaction).toBeUndefined();

		firstMessages.length = 0;
		const resumed = createAgent({ ...opts, resume: true });
		await resumed.agent.prompt("after restart");
		expect(firstMessages[0]).toContain("big 0");
	});

	it("never caches a summary from an aborted run, and resumes with the full history", async () => {
		faux.unregister();
		faux = registerFauxProvider({
			provider: "faux",
			models: [{ id: "faux-small", name: "Faux Small", contextWindow: 20_270 }],
		});
		const firstMessages: string[] = [];
		let abortDuringSummary = false;
		let summaries = 0;
		const opts = {
			cwd,
			configOverride: { model: faux.getModel(), apiKey: "test-key", source: "explicit" as const },
			autoApprove: true,
		};
		const bundle = createAgent(opts);
		faux.setResponses(
			Array.from({ length: 80 }, () => (context: Context) => {
				if (context.systemPrompt?.startsWith("Summarize the prior conversation")) {
					summaries++;
					// The user hits Ctrl+C while the summary is being written.
					if (abortDuringSummary) bundle.agent.abort();
					return fauxAssistantMessage(`summary #${summaries}`);
				}
				const first = context.messages[0];
				firstMessages.push(typeof first?.content === "string" ? first.content : JSON.stringify(first?.content));
				return fauxAssistantMessage("ok");
			}),
		);
		for (let i = 0; i < 9; i++) await bundle.agent.prompt(`big ${i} ${"x ".repeat(300)}`);
		abortDuringSummary = true;
		await bundle.agent.prompt(`big 9 ${"x ".repeat(300)}`).catch(() => undefined);

		expect(summaries).toBe(1);
		expect(bundle.sessions.load(faux.getModel().id)?.compaction).toBeUndefined();

		abortDuringSummary = false;
		firstMessages.length = 0;
		const resumed = createAgent({ ...opts, resume: true });
		await resumed.agent.prompt("after restart");
		// A fresh compaction may run after resume, but the aborted summary (#1) is never reused.
		expect(firstMessages[0]).not.toContain("summary #1");
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
		expect(bundle.memory.read("orchard_deploy.md")).toMatchObject({
			retrievalCount: 1,
			lastUsedAt: expect.any(Number),
			sourceSessionId: bundle.sessions.id,
		});
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
