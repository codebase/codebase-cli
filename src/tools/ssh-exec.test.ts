import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BackgroundShellStore } from "./background-shell-store.js";
import { FileStateCache } from "./file-state-cache.js";
import { createSshExec } from "./ssh-exec.js";
import { TaskStore } from "./task-store.js";
import type { ToolContext } from "./types.js";

/**
 * ssh-exec tests focus on the policy boundary, not on actually
 * spawning ssh. We don't want CI to depend on a reachable SSH host;
 * we just want to verify that:
 *   - unknown host names get rejected before any spawn
 *   - the shell-validator blocks rm-rf-style remote commands
 *   - args/host resolution work end to end
 *
 * Tests stub HOME via the `home` option threaded through loadSshConfig
 * — well, threaded through the tool's read. Since the tool calls
 * loadSshConfig() without an option override (production calls don't
 * thread one), we use a temp HOME via env, save/restore around tests.
 */

function makeCtx(cwd: string): ToolContext {
	return {
		cwd,
		fileStateCache: new FileStateCache(),
		tasks: new TaskStore(),
		userQueries: {
			ask: async () => "",
			cancel: () => undefined,
			current: () => undefined,
			respond: () => undefined,
			subscribe: () => () => undefined,
		} as never,
		planMode: {
			isActive: () => false,
			enter: () => undefined,
			exit: () => undefined,
			subscribe: () => () => undefined,
		} as never,
		memory: { addEntry: () => undefined, render: () => "", inject: () => "" } as never,
		hooks: { dispatch: async () => ({ blocked: false, ranCount: 0 }) } as never,
		backgroundShells: new BackgroundShellStore(),
		spawnSubagent: () => undefined as never,
	};
}

describe("ssh_exec", () => {
	let cwd: string;
	let home: string;
	let savedHome: string | undefined;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "codebase-ssh-exec-cwd-"));
		home = mkdtempSync(join(tmpdir(), "codebase-ssh-exec-home-"));
		savedHome = process.env.HOME;
		process.env.HOME = home;
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
		if (savedHome === undefined) delete process.env.HOME;
		else process.env.HOME = savedHome;
	});

	function writeConfig(hosts: unknown): void {
		mkdirSync(join(home, ".codebase"), { recursive: true });
		writeFileSync(join(home, ".codebase", "ssh.json"), JSON.stringify({ hosts }));
	}

	it("refuses an unknown host name with a helpful message", async () => {
		writeConfig([]);
		const tool = createSshExec(makeCtx(cwd));
		const result = await tool.execute(
			"call-1",
			{ host: "nope", command: "echo hi" } as never,
			new AbortController().signal,
		);
		expect(result.isError).toBe(true);
		expect((result.content[0] as { text: string }).text).toMatch(/unknown ssh host "nope"/i);
		// Suggests enrollment in the error.
		expect((result.content[0] as { text: string }).text).toMatch(/codebase ssh add/);
	});

	it("blocks rm -rf / on a known host without spawning ssh", async () => {
		writeConfig([{ name: "staging", host: "staging.example.com" }]);
		const tool = createSshExec(makeCtx(cwd));
		const result = await tool.execute(
			"call-2",
			{ host: "staging", command: "rm -rf /" } as never,
			new AbortController().signal,
		);
		expect(result.isError).toBe(true);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toMatch(/refused by the shell validator/i);
		expect(text).toMatch(/recursive delete targeting the filesystem root/i);
	});

	it("blocks dd-to-block-device piped through ssh too", async () => {
		writeConfig([{ name: "staging", host: "staging.example.com" }]);
		const tool = createSshExec(makeCtx(cwd));
		const result = await tool.execute(
			"call-3",
			{ host: "staging", command: "cat junk.iso | dd of=/dev/sda" } as never,
			new AbortController().signal,
		);
		expect(result.isError).toBe(true);
		expect((result.content[0] as { text: string }).text).toMatch(/raw write to a block device/i);
	});

	it("suggests known hosts when a typo is passed", async () => {
		writeConfig([
			{ name: "staging", host: "s.example" },
			{ name: "prod", host: "p.example" },
		]);
		const tool = createSshExec(makeCtx(cwd));
		const result = await tool.execute(
			"call-4",
			{ host: "stagign", command: "echo" } as never,
			new AbortController().signal,
		);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toMatch(/Known hosts: .*staging.*prod/);
	});
});
