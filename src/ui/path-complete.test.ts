import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { completePath, findAtTokenAt } from "./path-complete.js";

describe("completePath", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "pc-"));
	});
	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	function touch(rel: string, body = ""): void {
		const abs = join(cwd, rel);
		mkdirSync(join(abs, ".."), { recursive: true });
		writeFileSync(abs, body, "utf8");
	}
	function mkdir(rel: string): void {
		mkdirSync(join(cwd, rel), { recursive: true });
	}

	it("lists contents of cwd when prefix is empty", () => {
		touch("foo.ts");
		mkdir("src");
		const out = completePath("", cwd);
		// Directories appear first with trailing slash, then files alphabetical.
		expect(out).toContain("src/");
		expect(out).toContain("foo.ts");
	});

	it("filters by prefix case-insensitively", () => {
		touch("FooBar.ts");
		touch("other.ts");
		const out = completePath("foo", cwd);
		expect(out).toEqual(["FooBar.ts"]);
	});

	it("recurses into subdirs when prefix contains a slash", () => {
		touch("src/ui/Input.tsx");
		touch("src/ui/Other.tsx");
		const out = completePath("src/ui/In", cwd);
		expect(out).toEqual(["src/ui/Input.tsx"]);
	});

	it("ignores noisy directories", () => {
		mkdir("node_modules");
		mkdir(".git");
		touch("real.ts");
		const out = completePath("", cwd);
		expect(out).not.toContain("node_modules/");
		expect(out).not.toContain(".git/");
		expect(out).toContain("real.ts");
	});

	it("returns empty for non-existent dirs", () => {
		expect(completePath("nope/whatever", cwd)).toEqual([]);
	});
});

describe("findAtTokenAt", () => {
	it("finds an @-token at the start of buffer", () => {
		expect(findAtTokenAt("@src/foo", 8)).toEqual({ start: 0, prefix: "src/foo" });
	});

	it("finds an @-token after a space", () => {
		expect(findAtTokenAt("hi @src/foo", 11)).toEqual({ start: 3, prefix: "src/foo" });
	});

	it("returns null when cursor sits in plain text", () => {
		expect(findAtTokenAt("not an at sign", 5)).toBeNull();
	});

	it("returns null for inline @ that isn't a fresh token", () => {
		// `foo@bar` — the @ is preceded by letters, not whitespace.
		expect(findAtTokenAt("foo@bar.com", 11)).toBeNull();
	});

	it("handles empty prefix right after @", () => {
		expect(findAtTokenAt("@", 1)).toEqual({ start: 0, prefix: "" });
	});
});
