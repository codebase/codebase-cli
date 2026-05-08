import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadDotEnv, parseDotEnv } from "./loader.js";

describe("parseDotEnv", () => {
	it("parses bare KEY=value pairs", () => {
		const out = parseDotEnv("FOO=bar\nBAZ=qux");
		expect(out.get("FOO")).toBe("bar");
		expect(out.get("BAZ")).toBe("qux");
	});

	it("strips export prefix", () => {
		const out = parseDotEnv("export FOO=bar");
		expect(out.get("FOO")).toBe("bar");
	});

	it("ignores comments and blank lines", () => {
		const out = parseDotEnv("# comment\n\nFOO=bar\n  # indented comment\n");
		expect(out.size).toBe(1);
		expect(out.get("FOO")).toBe("bar");
	});

	it("handles double-quoted values with escapes", () => {
		const out = parseDotEnv(`FOO="line1\\nline2"\nBAR="say \\"hi\\""`);
		expect(out.get("FOO")).toBe("line1\nline2");
		expect(out.get("BAR")).toBe('say "hi"');
	});

	it("handles single-quoted values verbatim", () => {
		const out = parseDotEnv(`FOO='no\\nescapes'`);
		expect(out.get("FOO")).toBe("no\\nescapes");
	});

	it("strips trailing inline comments on unquoted values", () => {
		const out = parseDotEnv("FOO=bar # trailing");
		expect(out.get("FOO")).toBe("bar");
	});

	it("rejects invalid key names", () => {
		const out = parseDotEnv("123BAD=x\nGOOD_NAME=y");
		expect(out.has("123BAD")).toBe(false);
		expect(out.get("GOOD_NAME")).toBe("y");
	});

	it("ignores lines without =", () => {
		const out = parseDotEnv("noequals\nKEY=val");
		expect(out.size).toBe(1);
	});
});

describe("loadDotEnv", () => {
	let cwd: string;
	const original = { ...process.env };

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "dotenv-"));
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
		// restore process.env
		for (const k of Object.keys(process.env)) {
			if (!(k in original)) delete process.env[k];
		}
		Object.assign(process.env, original);
	});

	it("loads new keys from cwd .env", () => {
		writeFileSync(join(cwd, ".env"), "DOTENV_TEST_LOADER_NEW=hi\n");
		const applied = loadDotEnv(cwd);
		expect(applied).toContain("DOTENV_TEST_LOADER_NEW");
		expect(process.env.DOTENV_TEST_LOADER_NEW).toBe("hi");
	});

	it("does not override existing process.env values", () => {
		process.env.DOTENV_TEST_LOADER_EXISTING = "real";
		writeFileSync(join(cwd, ".env"), "DOTENV_TEST_LOADER_EXISTING=fake\n");
		const applied = loadDotEnv(cwd);
		expect(applied).not.toContain("DOTENV_TEST_LOADER_EXISTING");
		expect(process.env.DOTENV_TEST_LOADER_EXISTING).toBe("real");
	});

	it("silently skips missing files", () => {
		expect(() => loadDotEnv(cwd)).not.toThrow();
	});
});
