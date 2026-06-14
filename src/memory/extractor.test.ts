import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ExtractorModel, MemoryExtractor, parseProposals } from "./extractor.js";
import { MemoryStore } from "./store.js";

function user(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: 0 };
}
function assistant(text: string): AgentMessage {
	return { role: "assistant", content: text, timestamp: 0 };
}

/** A stub model returning a fixed reply, recording the last prompt it saw. */
function stubModel(reply: string): ExtractorModel & { lastPrompt?: string; calls: number } {
	const m = {
		calls: 0,
		lastPrompt: undefined as string | undefined,
		async fast(prompt: string) {
			m.calls += 1;
			m.lastPrompt = prompt;
			return reply;
		},
	};
	return m;
}

describe("parseProposals", () => {
	it("extracts a JSON array embedded in prose / fences", () => {
		const reply = 'Sure!\n```json\n[{"type":"user","name":"Role","description":"d","body":"b"}]\n```';
		expect(parseProposals(reply)).toEqual([{ type: "user", name: "Role", description: "d", body: "b" }]);
	});

	it("drops items with a bad type or missing fields", () => {
		const reply = JSON.stringify([
			{ type: "nonsense", name: "x", body: "y" },
			{ type: "feedback", name: "", body: "y" },
			{ type: "project", name: "Keep", body: "the body" },
		]);
		expect(parseProposals(reply)).toEqual([{ type: "project", name: "Keep", description: "Keep", body: "the body" }]);
	});

	it("returns [] when there's no array", () => {
		expect(parseProposals("nothing structured here")).toEqual([]);
		expect(parseProposals("[")).toEqual([]);
	});
});

describe("MemoryExtractor", () => {
	let dataRoot: string;
	let cwd: string;
	let store: MemoryStore;

	beforeEach(() => {
		dataRoot = mkdtempSync(join(tmpdir(), "mem-data-"));
		cwd = mkdtempSync(join(tmpdir(), "mem-cwd-"));
		store = new MemoryStore({ cwd, dataRoot });
	});
	afterEach(() => {
		rmSync(dataRoot, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	});

	const proposal = JSON.stringify([
		{
			type: "user",
			name: "Prefers tabs",
			description: "when formatting",
			body: "The user prefers tabs over spaces.",
		},
	]);

	it("does not run until the threshold of new messages is reached", async () => {
		const model = stubModel(proposal);
		const ext = new MemoryExtractor({ store, model, threshold: 4 });
		expect(await ext.maybeExtract([user("a"), assistant("b")])).toEqual([]);
		expect(model.calls).toBe(0);
	});

	it("extracts, saves, and updates the index once the threshold is met", async () => {
		const model = stubModel(proposal);
		const ext = new MemoryExtractor({ store, model, threshold: 2 });
		const saved = await ext.maybeExtract([user("a"), assistant("b"), user("c")]);
		expect(saved).toHaveLength(1);
		expect(saved[0].type).toBe("user");
		expect(store.list()).toHaveLength(1);
		expect(store.index()).toContain("Prefers tabs");
	});

	it("advances its high-water mark so it doesn't re-mine old messages", async () => {
		const model = stubModel(proposal);
		const ext = new MemoryExtractor({ store, model, threshold: 2 });
		await ext.maybeExtract([user("a"), assistant("b")]);
		expect(model.calls).toBe(1);
		// One more message is below threshold relative to the new mark.
		expect(await ext.maybeExtract([user("a"), assistant("b"), user("c")])).toEqual([]);
		expect(model.calls).toBe(1);
	});

	it("respects startAt so a resumed transcript isn't re-extracted", async () => {
		const model = stubModel(proposal);
		const ext = new MemoryExtractor({ store, model, threshold: 2, startAt: 10 });
		expect(await ext.maybeExtract([user("a"), assistant("b")])).toEqual([]);
		expect(model.calls).toBe(0);
	});

	it("is a no-op when disabled", async () => {
		const model = stubModel(proposal);
		const ext = new MemoryExtractor({ store, model, threshold: 1, disabled: true });
		expect(await ext.maybeExtract([user("a"), user("b")])).toEqual([]);
		expect(model.calls).toBe(0);
	});

	it("skips a proposal whose subject already has a memory", async () => {
		store.save({ filename: "prefers-tabs-abc.md", name: "Prefers tabs", description: "d", type: "user", body: "x" });
		const model = stubModel(proposal);
		const ext = new MemoryExtractor({ store, model, threshold: 2 });
		const saved = await ext.maybeExtract([user("a"), assistant("b")]);
		expect(saved).toEqual([]);
		expect(store.list()).toHaveLength(1);
	});

	it("never throws when the model errors", async () => {
		const model: ExtractorModel = {
			async fast() {
				throw new Error("model down");
			},
		};
		const ext = new MemoryExtractor({ store, model, threshold: 1 });
		await expect(ext.maybeExtract([user("a"), assistant("b")])).resolves.toEqual([]);
	});
});
