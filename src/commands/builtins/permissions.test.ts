import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PermissionStore } from "../../permissions/store.js";
import type { CommandContext } from "../types.js";
import { permissions } from "./permissions.js";

describe("/permissions", () => {
	let cwd: string;
	let emits: string[];
	let ctx: CommandContext;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "permissions-cwd-"));
		emits = [];
		ctx = {
			emit: (text: string) => emits.push(text),
			bundle: {
				toolContext: { cwd },
				permissions: new PermissionStore(),
			},
		} as unknown as CommandContext;
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("explains shell auto-allow and validator policy", () => {
		permissions.handler("shell", ctx);

		expect(emits).toHaveLength(1);
		expect(emits[0]).toContain("Shell permission policy:");
		expect(emits[0]).toContain("auto-allowed read-only prefixes");
		expect(emits[0]).toContain("shell:git commit*");
		expect(emits[0]).toContain("hard blocks:");
		expect(emits[0]).toContain("warnings:");
	});

	it("suggests when a shell command is already auto-allowed", () => {
		permissions.handler("suggest git status --short", ctx);

		expect(emits).toHaveLength(1);
		expect(emits[0]).toContain("Shell permission suggestion:");
		expect(emits[0]).toContain("command: git status --short");
		expect(emits[0]).toContain("already auto-allowed");
	});

	it("suggests a narrow allow and deny rule for prompted shell commands", () => {
		permissions.handler("suggest npm install", ctx);

		expect(emits[0]).toContain("will prompt");
		expect(emits[0]).toContain("session trust scope: shell:npm install*");
		expect(emits[0]).toContain("/permissions allow shell:npm install*");
		expect(emits[0]).toContain("/permissions deny shell:npm install*");
	});

	it("surfaces validator warnings and safer paths", () => {
		permissions.handler("suggest sudo apt update", ctx);

		expect(emits[0]).toContain("will prompt as high risk");
		expect(emits[0]).toContain("uses sudo");
		expect(emits[0]).toContain("safer path:");
		expect(emits[0]).toContain("session trust scope: shell:apt update*");
	});

	it("does not suggest allow rules for hard-blocked shell commands", () => {
		permissions.handler("suggest rm -rf /", ctx);

		expect(emits[0]).toContain("hard-blocked by shell validator");
		expect(emits[0]).toContain("no allow rule is offered");
		expect(emits[0]).not.toContain("/permissions allow");
	});

	it("simulates a multi-command shell plan", () => {
		permissions.handler("simulate git status --short && sudo apt update; rm -rf /", ctx);

		expect(emits).toHaveLength(1);
		expect(emits[0]).toContain("Permission simulation:");
		expect(emits[0]).toContain("1. ALLOW low [built-in-read-only] git status --short");
		expect(emits[0]).toContain("2. PROMPT high [prompt] sudo apt update");
		expect(emits[0]).toContain("trust scope: shell:apt update*");
		expect(emits[0]).toContain("safer path:");
		expect(emits[0]).toContain("3. BLOCK high [shell-validator] rm -rf /");
		expect(emits[0]).toContain("no allow rule is offered");
		expect(emits[0]).toContain("Summary: allow 1, prompt 1, block 1.");
	});

	it("does not split simulator commands inside quotes", () => {
		permissions.handler('simulate echo "a && b"; npm install', ctx);

		expect(emits[0]).toContain('1. ALLOW low [built-in-read-only] echo "a && b"');
		expect(emits[0]).toContain("2. PROMPT medium [prompt] npm install");
		expect(emits[0]).toContain("Summary: allow 1, prompt 1, block 0.");
	});

	it("shows usage for missing shell suggestions", () => {
		permissions.handler("suggest", ctx);

		expect(emits).toEqual(["Usage: /permissions suggest <shell command>"]);
	});

	it("shows usage for missing shell simulations", () => {
		permissions.handler("simulate", ctx);

		expect(emits).toEqual(["Usage: /permissions simulate <shell command plan>"]);
	});
});
