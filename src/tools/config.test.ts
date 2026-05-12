import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeMockToolContext } from "./__test__/mock-tool-context.js";
import { createConfig } from "./config.js";

const makeCtx = makeMockToolContext;

describe("config tool", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "config-tool-"));
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("returns the merged config when no path is given", async () => {
		mkdirSync(join(cwd, ".codebase"), { recursive: true });
		writeFileSync(join(cwd, ".codebase", "config.json"), JSON.stringify({ permissions: { allow: ["list_files"] } }));
		// Use HOME=/nonexistent so the user-layer is empty.
		const oldHome = process.env.HOME;
		process.env.HOME = "/nonexistent-config-test-home";
		try {
			const tool = createConfig(makeCtx(cwd));
			const result = await tool.execute("call-1", {}, undefined, undefined);
			expect(result.details.value).toEqual({ permissions: { allow: ["list_files"] } });
			expect(result.content[0].type).toBe("text");
		} finally {
			process.env.HOME = oldHome;
		}
	});

	it("returns a specific dotted path when given", async () => {
		mkdirSync(join(cwd, ".codebase"), { recursive: true });
		writeFileSync(
			join(cwd, ".codebase", "config.json"),
			JSON.stringify({ permissions: { allow: ["a", "b"] }, theme: "dark" }),
		);
		const oldHome = process.env.HOME;
		process.env.HOME = "/nonexistent-config-test-home";
		try {
			const tool = createConfig(makeCtx(cwd));
			const result = await tool.execute("call-1", { path: "permissions.allow" }, undefined, undefined);
			expect(result.details.value).toEqual(["a", "b"]);
			expect(result.details.path).toBe("permissions.allow");
		} finally {
			process.env.HOME = oldHome;
		}
	});

	it("returns undefined for a missing path", async () => {
		const oldHome = process.env.HOME;
		process.env.HOME = "/nonexistent-config-test-home";
		try {
			const tool = createConfig(makeCtx(cwd));
			const result = await tool.execute("call-1", { path: "does.not.exist" }, undefined, undefined);
			expect(result.details.value).toBeUndefined();
		} finally {
			process.env.HOME = oldHome;
		}
	});

	it("supports array indexing in the dotted path", async () => {
		mkdirSync(join(cwd, ".codebase"), { recursive: true });
		writeFileSync(
			join(cwd, ".codebase", "config.json"),
			JSON.stringify({ permissions: { allow: ["first", "second", "third"] } }),
		);
		const oldHome = process.env.HOME;
		process.env.HOME = "/nonexistent-config-test-home";
		try {
			const tool = createConfig(makeCtx(cwd));
			const result = await tool.execute("call-1", { path: "permissions.allow.1" }, undefined, undefined);
			expect(result.details.value).toBe("second");
		} finally {
			process.env.HOME = oldHome;
		}
	});
});
