import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveInsideCwd, validateForOverwrite } from "./file-ops.js";
import { FileStateCache } from "./file-state-cache.js";
import { validateShellCommand } from "./shell-validator.js";

/**
 * Tests for the unrestricted opt-outs. Each one verifies BOTH that the
 * restriction holds by default AND that the env flag relaxes it, so a
 * future refactor that accidentally drops the gate is caught.
 */

describe("CODEBASE_NO_PROJECT_ROOT", () => {
	let saved: string | undefined;
	let cwd: string;

	beforeEach(() => {
		saved = process.env.CODEBASE_NO_PROJECT_ROOT;
		delete process.env.CODEBASE_NO_PROJECT_ROOT;
		cwd = mkdtempSync(join(tmpdir(), "codebase-unrestricted-"));
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
		if (saved === undefined) delete process.env.CODEBASE_NO_PROJECT_ROOT;
		else process.env.CODEBASE_NO_PROJECT_ROOT = saved;
	});

	it("default: rejects /etc/passwd as outside the project root", () => {
		expect(() => resolveInsideCwd(cwd, "/etc/passwd")).toThrow(/outside/i);
	});

	it("default: rejects ../escape paths", () => {
		expect(() => resolveInsideCwd(cwd, "../../../etc/passwd")).toThrow(/outside/i);
	});

	it("unrestricted=1: lets /etc/passwd through verbatim", () => {
		process.env.CODEBASE_NO_PROJECT_ROOT = "1";
		expect(resolveInsideCwd(cwd, "/etc/passwd")).toBe("/etc/passwd");
	});

	it("unrestricted=1: lets ../escape resolve normally", () => {
		process.env.CODEBASE_NO_PROJECT_ROOT = "1";
		const out = resolveInsideCwd(cwd, "../sibling/file");
		expect(out).not.toContain(cwd);
		expect(out.endsWith("/sibling/file")).toBe(true);
	});
});

describe("CODEBASE_NO_VALIDATOR", () => {
	let saved: string | undefined;

	beforeEach(() => {
		saved = process.env.CODEBASE_NO_VALIDATOR;
		delete process.env.CODEBASE_NO_VALIDATOR;
	});

	afterEach(() => {
		if (saved === undefined) delete process.env.CODEBASE_NO_VALIDATOR;
		else process.env.CODEBASE_NO_VALIDATOR = saved;
	});

	it("default: blocks `rm -rf /`", () => {
		expect(validateShellCommand("rm -rf /").verdict).toBe("block");
	});

	it("default: warns on `sudo apt update`", () => {
		expect(validateShellCommand("sudo apt update").verdict).toBe("warn");
	});

	it("unrestricted=1: allows `rm -rf /`", () => {
		process.env.CODEBASE_NO_VALIDATOR = "1";
		expect(validateShellCommand("rm -rf /").verdict).toBe("allow");
	});

	it("unrestricted=1: allows `sudo apt update` without warn", () => {
		process.env.CODEBASE_NO_VALIDATOR = "1";
		expect(validateShellCommand("sudo apt update").verdict).toBe("allow");
	});
});

describe("CODEBASE_NO_READ_BEFORE_WRITE", () => {
	let saved: string | undefined;
	let cache: FileStateCache;

	beforeEach(() => {
		saved = process.env.CODEBASE_NO_READ_BEFORE_WRITE;
		delete process.env.CODEBASE_NO_READ_BEFORE_WRITE;
		cache = new FileStateCache();
	});

	afterEach(() => {
		if (saved === undefined) delete process.env.CODEBASE_NO_READ_BEFORE_WRITE;
		else process.env.CODEBASE_NO_READ_BEFORE_WRITE = saved;
	});

	it("default: throws FileNotReadFirstError when the file wasn't read", () => {
		expect(() => validateForOverwrite("/tmp/never-read.txt", cache)).toThrow();
	});

	it("unrestricted=1: returns a synthetic snapshot without throwing", () => {
		process.env.CODEBASE_NO_READ_BEFORE_WRITE = "1";
		const snap = validateForOverwrite("/tmp/never-read.txt", cache);
		expect(snap.path).toBe("/tmp/never-read.txt");
		expect(snap.isPartialView).toBe(false);
		expect(snap.size).toBe(0);
	});
});
