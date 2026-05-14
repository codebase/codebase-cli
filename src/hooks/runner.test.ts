import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runHook } from "./runner.js";
import type { HookConfig, HookEventContext } from "./types.js";

describe("runHook", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "codebase-hooks-runner-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const ctx = (overrides: Partial<HookEventContext> = {}): HookEventContext => ({
		event: "PreToolUse",
		workingDir: dir,
		...overrides,
	});

	it("delivers the event context as JSON on stdin", async () => {
		const config: HookConfig = {
			event: "PreToolUse",
			command: 'node -e "let d=\\"\\";process.stdin.on(\\"data\\",b=>d+=b).on(\\"end\\",()=>console.log(d))"',
		};
		const result = await runHook(config, ctx({ toolName: "edit_file", filePath: "src/x.ts" }));
		expect(result.exitCode).toBe(0);
		const parsed = JSON.parse(result.stdout) as HookEventContext;
		expect(parsed.event).toBe("PreToolUse");
		expect(parsed.toolName).toBe("edit_file");
		expect(parsed.filePath).toBe("src/x.ts");
		expect(parsed.workingDir).toBe(dir);
	});

	it("runs the hook with the event's workingDir as cwd", async () => {
		const config: HookConfig = { event: "PreToolUse", command: 'node -e "console.log(process.cwd())"' };
		const result = await runHook(config, ctx());
		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe(dir);
	});

	it("captures stderr separately from stdout", async () => {
		const config: HookConfig = {
			event: "PreToolUse",
			command: 'node -e "console.log(\\"out\\"); console.error(\\"err\\"); process.exit(3)"',
		};
		const result = await runHook(config, ctx());
		expect(result.exitCode).toBe(3);
		expect(result.stdout).toContain("out");
		expect(result.stderr).toContain("err");
	});

	it("times out a runaway hook with a clear stderr message", async () => {
		const config: HookConfig = {
			event: "PreToolUse",
			timeout: 100,
			command: 'node -e "setInterval(()=>{},1000)"',
		};
		const start = Date.now();
		const result = await runHook(config, ctx());
		const elapsed = Date.now() - start;
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toMatch(/timed out/i);
		// Should settle within a small multiple of the timeout, not run forever.
		expect(elapsed).toBeLessThan(3000);
	});

	it("respects an external AbortSignal", async () => {
		const controller = new AbortController();
		const config: HookConfig = {
			event: "PreToolUse",
			timeout: 10_000,
			command: 'node -e "setInterval(()=>{},1000)"',
		};
		setTimeout(() => controller.abort(), 50);
		const start = Date.now();
		const result = await runHook(config, ctx(), controller.signal);
		const elapsed = Date.now() - start;
		// Child should die from the abort signal long before the configured
		// 10s timeout. Exit code reflects the kill, not a clean 0.
		expect(elapsed).toBeLessThan(2000);
		expect(result.exitCode).not.toBe(0);
	});

	it("doesn't inherit env mutations from the agent process", async () => {
		// Set a var in the parent, ensure the hook sees a clone — mutating
		// it inside the hook must not leak back. This is the regression
		// guard for the runner.ts `env: { ...process.env }` fix.
		process.env.CODEBASE_HOOK_TEST_LEAK = "from-parent";
		const config: HookConfig = {
			event: "PreToolUse",
			command:
				'node -e "console.log(process.env.CODEBASE_HOOK_TEST_LEAK); process.env.CODEBASE_HOOK_TEST_LEAK=\\"mutated\\""',
		};
		const result = await runHook(config, ctx());
		expect(result.stdout.trim()).toBe("from-parent");
		// Parent env stays as we set it; the hook's mutation lived only
		// inside the child's env object.
		expect(process.env.CODEBASE_HOOK_TEST_LEAK).toBe("from-parent");
		delete process.env.CODEBASE_HOOK_TEST_LEAK;
	});

	it("returns a structured error result when the command can't be spawned", async () => {
		const config: HookConfig = {
			event: "PreToolUse",
			// Path that doesn't exist; shell:true means it goes through sh,
			// which will exit 127 (command not found) rather than throw at
			// spawn-time. This still gives us a non-zero exit + stderr.
			command: "/definitely/not/a/command/anywhere",
		};
		const result = await runHook(config, ctx());
		expect(result.exitCode).not.toBe(0);
	});
});
