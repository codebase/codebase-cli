import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackgroundShellStore } from "./background-shell-store.js";
import { FileStateCache } from "./file-state-cache.js";
import { createShell, OutputAccumulator } from "./shell.js";
import type { ToolContext } from "./types.js";

function makeCtx(cwd: string): ToolContext {
	return { cwd, fileStateCache: new FileStateCache(), backgroundShells: new BackgroundShellStore() };
}

async function run(ctx: ToolContext, params: Parameters<ReturnType<typeof createShell>["execute"]>[1]) {
	const tool = createShell(ctx);
	const onUpdate = vi.fn();
	const controller = new AbortController();
	const result = await tool.execute("call", params, controller.signal, onUpdate);
	return { result, onUpdate, controller };
}

describe("OutputAccumulator", () => {
	it("returns full text when under cap", () => {
		const acc = new OutputAccumulator();
		acc.add(Buffer.from("hello"));
		const v = acc.visible(100);
		expect(v.truncated).toBe(false);
		expect(v.text).toBe("hello");
	});

	it("head+tail truncates with a notice when over cap", () => {
		const acc = new OutputAccumulator();
		acc.add(Buffer.from("A".repeat(500)));
		acc.add(Buffer.from("B".repeat(500)));
		const v = acc.visible(200);
		expect(v.truncated).toBe(true);
		expect(v.text).toMatch(/truncated/);
		expect(v.text.startsWith("A")).toBe(true);
		expect(v.text.endsWith("B")).toBe(true);
	});
});

describe("shell tool", () => {
	let dir: string;
	let ctx: ToolContext;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "shell-"));
		ctx = makeCtx(dir);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("captures stdout from a simple command", async () => {
		const { result } = await run(ctx, { command: "echo hello" });
		expect((result.content[0] as { type: "text"; text: string }).text).toMatch(/hello/);
		expect(result.details.exitCode).toBe(0);
		expect(result.details.aborted).toBe(false);
		expect(result.details.timedOut).toBe(false);
	});

	it("captures stderr alongside stdout", async () => {
		const { result } = await run(ctx, { command: "echo to_stdout && echo to_stderr 1>&2" });
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toMatch(/to_stdout/);
		expect(text).toMatch(/to_stderr/);
	});

	it("returns the non-zero exit code in details", async () => {
		const { result } = await run(ctx, { command: "exit 7" });
		expect(result.details.exitCode).toBe(7);
	});

	it("respects cwd relative to the project root", async () => {
		const sub = join(dir, "sub");
		require("node:fs").mkdirSync(sub);
		const { result } = await run(ctx, { command: "pwd", cwd: "sub" });
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toMatch(/sub/);
	});

	it("rejects cwd outside the project root", async () => {
		await expect(run(ctx, { command: "pwd", cwd: "../../etc" })).rejects.toThrow(/outside the project root/);
	});

	it("moves a timed-out command to the background instead of killing it", async () => {
		const { result } = await run(ctx, { command: "sleep 5", timeout_ms: 200 });
		// Does NOT throw — returns a background-adopted result.
		expect(result.details.timedOut).toBe(true);
		expect(result.details.backgroundId).toMatch(/^bg-/);
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toMatch(/moved to the background/);
		expect(text).toMatch(/STILL RUNNING/);
		// The process is tracked + running in the store.
		const record = ctx.backgroundShells.get(result.details.backgroundId as string);
		expect(record?.status).toBe("running");
		// Clean up so the sleep doesn't outlive the test.
		await ctx.backgroundShells.kill(result.details.backgroundId as string);
	});

	it("aborts when the abort signal fires", async () => {
		const tool = createShell(ctx);
		const controller = new AbortController();
		const promise = tool.execute("call", { command: "sleep 5", timeout_ms: 10_000 }, controller.signal);
		setTimeout(() => controller.abort(), 100);
		const result = await promise;
		expect(result.details.aborted).toBe(true);
	});

	it("emits onUpdate during streaming output", async () => {
		const tool = createShell(ctx);
		const onUpdate = vi.fn();
		// Three writes spaced 150ms apart so the 100ms throttle releases between them.
		await tool.execute(
			"call",
			{ command: "sh -c 'echo a; sleep 0.15; echo b; sleep 0.15; echo c'" },
			undefined,
			onUpdate,
		);
		expect(onUpdate).toHaveBeenCalled();
	});

	it("spills oversized output to a temp file and surfaces the path", async () => {
		// Produce ~50 KB on stdout (over the 30 KB visible cap)
		const { result } = await run(ctx, {
			command: "yes x | head -c 50000",
			timeout_ms: 10_000,
		});
		expect(result.details.truncated).toBe(true);
		expect(result.details.spillPath).not.toBeNull();
		const path = result.details.spillPath!;
		expect(existsSync(path)).toBe(true);
		const spilled = readFileSync(path);
		expect(spilled.length).toBeGreaterThanOrEqual(50_000);
		rmSync(path, { force: true });
	});

	it("returns under the visible cap for normal-sized output", async () => {
		const { result } = await run(ctx, { command: "echo small" });
		expect(result.details.truncated).toBe(false);
		expect(result.details.spillPath).toBeNull();
	});
});
