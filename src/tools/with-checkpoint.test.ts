import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CheckpointStore } from "../checkpoint/store.js";
import type { ToolContext } from "./types.js";
import { withCheckpoint } from "./with-checkpoint.js";

function fakeTool(name: string, impl: () => Promise<any>): AgentTool<any> {
	return {
		name,
		label: name,
		description: "",
		parameters: {} as any,
		execute: impl,
	} as unknown as AgentTool<any>;
}

describe("withCheckpoint", () => {
	let cwd: string;
	let dataRoot: string;
	let store: CheckpointStore;
	let ctx: ToolContext;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "wc-cwd-"));
		dataRoot = mkdtempSync(join(tmpdir(), "wc-data-"));
		store = new CheckpointStore({ cwd, dataRoot });
		ctx = { cwd, checkpoints: store } as unknown as ToolContext;
	});
	afterEach(() => {
		store.dispose();
		rmSync(cwd, { recursive: true, force: true });
		rmSync(dataRoot, { recursive: true, force: true });
	});

	it("snapshots the target before a mutating tool runs", async () => {
		writeFileSync(join(cwd, "a.ts"), "before");
		const tool = withCheckpoint(
			fakeTool("edit_file", async () => ({ content: [{ type: "text", text: "ok" }] })),
			ctx,
		);
		await tool.execute("tc", { path: "a.ts" }, undefined, undefined);
		expect(store.list()).toHaveLength(1);
		expect(store.list()[0]).toMatchObject({ display: "a.ts", existed: true });
	});

	it("discards the entry when the tool throws", async () => {
		writeFileSync(join(cwd, "a.ts"), "before");
		const tool = withCheckpoint(
			fakeTool("edit_file", async () => {
				throw new Error("no match");
			}),
			ctx,
		);
		await expect(tool.execute("tc", { path: "a.ts" }, undefined, undefined)).rejects.toThrow();
		expect(store.list()).toEqual([]);
	});

	it("discards the entry when the tool reports isError", async () => {
		writeFileSync(join(cwd, "a.ts"), "before");
		const tool = withCheckpoint(
			fakeTool("edit_file", async () => ({ content: [{ type: "text", text: "refused" }], isError: true })),
			ctx,
		);
		await tool.execute("tc", { path: "a.ts" }, undefined, undefined);
		expect(store.list()).toEqual([]);
	});

	it("leaves non-mutating tools untouched", () => {
		const tool = fakeTool("read_file", async () => ({ content: [] }));
		expect(withCheckpoint(tool, ctx)).toBe(tool);
	});

	it("passes through when no checkpoint store is configured", () => {
		const tool = fakeTool("edit_file", async () => ({ content: [] }));
		expect(withCheckpoint(tool, { cwd } as unknown as ToolContext)).toBe(tool);
	});
});
