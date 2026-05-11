import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildAttachmentPrompt, collectAttachments, MAX_ATTACHMENTS } from "./attachments.js";

describe("collectAttachments", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "attach-"));
	});
	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	function touch(rel: string, body: string): void {
		const abs = join(cwd, rel);
		mkdirSync(join(abs, ".."), { recursive: true });
		writeFileSync(abs, body, "utf8");
	}

	it("returns empty when there are no @tokens", () => {
		expect(collectAttachments("just a regular prompt", cwd)).toEqual([]);
	});

	it("resolves a single @path token to a file", () => {
		touch("src/foo.ts", "export const foo = 1;");
		const out = collectAttachments("fix @src/foo.ts", cwd);
		expect(out).toHaveLength(1);
		expect(out[0].relPath).toBe("src/foo.ts");
		expect(out[0].content).toBe("export const foo = 1;");
	});

	it("ignores email-style @mentions without slashes or dots", () => {
		expect(collectAttachments("ping @alice or @bob about it", cwd)).toEqual([]);
	});

	it("dedupes repeated @paths", () => {
		touch("a.ts", "// a");
		const out = collectAttachments("@a.ts vs @a.ts again", cwd);
		expect(out).toHaveLength(1);
	});

	it("skips paths that point to a directory", () => {
		mkdirSync(join(cwd, "subdir"), { recursive: true });
		const out = collectAttachments("look at @subdir/", cwd);
		expect(out).toEqual([]);
	});

	it("skips non-existent paths silently", () => {
		expect(collectAttachments("see @nope/missing.txt", cwd)).toEqual([]);
	});

	it("respects MAX_ATTACHMENTS", () => {
		const tokens: string[] = [];
		for (let i = 0; i < MAX_ATTACHMENTS + 4; i++) {
			touch(`f${i}.ts`, `// ${i}`);
			tokens.push(`@f${i}.ts`);
		}
		const out = collectAttachments(tokens.join(" "), cwd);
		expect(out).toHaveLength(MAX_ATTACHMENTS);
	});

	it("skips overlong path tokens", () => {
		const long = `${"a/".repeat(140)}b.ts`; // 281 chars
		expect(collectAttachments(`@${long}`, cwd)).toEqual([]);
	});
});

describe("buildAttachmentPrompt", () => {
	it("inlines attachments above the user's ask", () => {
		const out = buildAttachmentPrompt("fix it", [
			{ token: "@a.ts", relPath: "a.ts", absPath: "/cwd/a.ts", content: "const a = 1;" },
		]);
		expect(out).toMatch(/Attached files/);
		expect(out).toMatch(/### a\.ts/);
		expect(out).toMatch(/const a = 1;/);
		expect(out).toMatch(/---\nfix it$/);
	});
});
