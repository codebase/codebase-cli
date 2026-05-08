import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HookManager, hookMatches } from "./manager.js";

describe("hookMatches", () => {
	const ctx = (toolName: string, filePath?: string) => ({
		event: "PreToolUse" as const,
		toolName,
		filePath,
		workingDir: "/tmp",
	});

	it("matches anything when matcher is undefined", () => {
		expect(hookMatches(undefined, ctx("anything"))).toBe(true);
	});

	it("matches by exact tool name", () => {
		expect(hookMatches("edit_file", ctx("edit_file"))).toBe(true);
		expect(hookMatches("edit_file", ctx("write_file"))).toBe(false);
	});

	it("matches alternatives via pipe", () => {
		expect(hookMatches("edit_file|write_file", ctx("write_file"))).toBe(true);
		expect(hookMatches("edit_file|write_file", ctx("shell"))).toBe(false);
	});

	it("matches tool wildcard", () => {
		expect(hookMatches("*", ctx("anything"))).toBe(true);
	});

	it("matches tool + path glob", () => {
		expect(hookMatches("edit_file:*.ts", ctx("edit_file", "src/foo.ts"))).toBe(false); // *.ts only matches no-dir
		expect(hookMatches("edit_file:**.ts", ctx("edit_file", "src/foo.ts"))).toBe(true);
		expect(hookMatches("edit_file:**.md", ctx("edit_file", "src/foo.ts"))).toBe(false);
	});

	it("matches wildcard tool + path glob", () => {
		expect(hookMatches("*:**.json", ctx("write_file", "package.json"))).toBe(true);
	});

	it("rejects when filePath is missing for path-bearing matcher", () => {
		expect(hookMatches("edit_file:**.ts", ctx("edit_file"))).toBe(false);
	});
});

describe("HookManager", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "hooks-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function writeHooksFile(name: string, hooks: object[]): string {
		const path = join(dir, name);
		writeFileSync(path, JSON.stringify({ hooks }));
		return path;
	}

	it("loads hooks from one or more files in order", () => {
		const home = writeHooksFile("home.json", [{ event: "PreToolUse", command: "echo home" }]);
		const project = writeHooksFile("project.json", [{ event: "PostToolUse", command: "echo project" }]);

		const mgr = new HookManager();
		mgr.loadFrom(home, project);
		expect(mgr.all()).toHaveLength(2);
	});

	it("ignores missing files silently", () => {
		const mgr = new HookManager();
		mgr.loadFrom(join(dir, "nope.json"));
		expect(mgr.all()).toHaveLength(0);
	});

	it("skips entries missing event or command", () => {
		const path = writeHooksFile("bad.json", [
			{ event: "PreToolUse" }, // missing command
			{ command: "echo" }, // missing event
			{ event: "PreToolUse", command: "echo ok" },
		]);
		const mgr = new HookManager();
		mgr.loadFrom(path);
		expect(mgr.all()).toHaveLength(1);
	});

	it("dispatches a hook and reports it ran", async () => {
		const path = writeHooksFile("dispatch.json", [{ event: "PreToolUse", command: 'node -e "process.exit(0)"' }]);
		const mgr = new HookManager();
		mgr.loadFrom(path);
		const outcome = await mgr.dispatch("PreToolUse", {
			event: "PreToolUse",
			toolName: "edit_file",
			workingDir: dir,
		});
		expect(outcome.ranCount).toBe(1);
		expect(outcome.blocked).toBe(false);
	});

	it("blocks when a synchronous hook exits 2", async () => {
		const path = writeHooksFile("block.json", [
			{
				event: "PreToolUse",
				matcher: "edit_file",
				command: 'node -e "console.error(\\"blocked!\\"); process.exit(2)"',
			},
		]);
		const mgr = new HookManager();
		mgr.loadFrom(path);
		const outcome = await mgr.dispatch("PreToolUse", {
			event: "PreToolUse",
			toolName: "edit_file",
			workingDir: dir,
		});
		expect(outcome.blocked).toBe(true);
		expect(outcome.reason).toContain("blocked!");
	});

	it("does not block when a hook exits non-zero non-2 (treated as soft failure)", async () => {
		const path = writeHooksFile("soft.json", [{ event: "PreToolUse", command: 'node -e "process.exit(7)"' }]);
		const mgr = new HookManager();
		mgr.loadFrom(path);
		const outcome = await mgr.dispatch("PreToolUse", {
			event: "PreToolUse",
			toolName: "edit_file",
			workingDir: dir,
		});
		expect(outcome.blocked).toBe(false);
		expect(outcome.ranCount).toBe(1);
	});

	it("filters by matcher", async () => {
		const path = writeHooksFile("filter.json", [
			{ event: "PreToolUse", matcher: "edit_file", command: 'node -e "process.exit(0)"' },
			{ event: "PreToolUse", matcher: "shell", command: 'node -e "process.exit(0)"' },
		]);
		const mgr = new HookManager();
		mgr.loadFrom(path);
		const outcome = await mgr.dispatch("PreToolUse", {
			event: "PreToolUse",
			toolName: "edit_file",
			workingDir: dir,
		});
		expect(outcome.ranCount).toBe(1);
	});

	it("runs async hooks fire-and-forget without blocking", async () => {
		const path = writeHooksFile("async.json", [
			{ event: "PostToolUse", async: true, command: 'node -e "process.exit(2)"' },
		]);
		const mgr = new HookManager();
		mgr.loadFrom(path);
		const outcome = await mgr.dispatch("PostToolUse", {
			event: "PostToolUse",
			toolName: "edit_file",
			workingDir: dir,
		});
		// Even though the async hook would exit 2 if awaited, it doesn't block.
		expect(outcome.blocked).toBe(false);
		expect(outcome.ranCount).toBe(1);
	});

	it("times out a runaway hook", async () => {
		const path = writeHooksFile("timeout.json", [
			{ event: "PreToolUse", timeout: 200, command: 'node -e "setInterval(()=>{},1000)"' },
		]);
		const mgr = new HookManager();
		mgr.loadFrom(path);
		const outcome = await mgr.dispatch("PreToolUse", {
			event: "PreToolUse",
			toolName: "edit_file",
			workingDir: dir,
		});
		// Timeout returns exit 1, not 2 — so it doesn't block.
		expect(outcome.blocked).toBe(false);
		expect(outcome.ranCount).toBe(1);
	});
});
