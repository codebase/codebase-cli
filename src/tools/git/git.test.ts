import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileStateCache } from "../file-state-cache.js";
import type { ToolContext } from "../types.js";
import { createGitDiff } from "./diff.js";
import { createGitLog } from "./log.js";
import { createGitStatus } from "./status.js";

function makeCtx(cwd: string): ToolContext {
	return { cwd, fileStateCache: new FileStateCache() };
}

function git(cmd: string, cwd: string): void {
	execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

function setupRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "git-"));
	git("init -q -b main", dir);
	git("config user.email t@t.test", dir);
	git("config user.name tester", dir);
	writeFileSync(join(dir, "README.md"), "# initial\n");
	git("add README.md", dir);
	git("commit -q -m 'initial commit'", dir);
	return dir;
}

describe("git_status", () => {
	let dir: string;
	let ctx: ToolContext;

	beforeEach(() => {
		dir = setupRepo();
		ctx = makeCtx(dir);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("reports a clean working tree", async () => {
		const result = await createGitStatus(ctx).execute("call", {});
		expect(result.details.clean).toBe(true);
		expect(result.details.branch).toBe("main");
		expect(result.details.entries).toEqual([]);
	});

	it("reports modified, staged, and untracked files", async () => {
		writeFileSync(join(dir, "README.md"), "# edited\n");
		writeFileSync(join(dir, "new.txt"), "hi\n");
		writeFileSync(join(dir, "staged.txt"), "queued\n");
		git("add staged.txt", dir);

		const result = await createGitStatus(ctx).execute("call", {});
		const paths = result.details.entries.map((e) => e.path);
		expect(paths).toContain("README.md");
		expect(paths).toContain("new.txt");
		expect(paths).toContain("staged.txt");
		expect(result.details.clean).toBe(false);
	});

	it("rejects when cwd is not a git repo", async () => {
		const nonRepo = mkdtempSync(join(tmpdir(), "norepo-"));
		const nonCtx = makeCtx(nonRepo);
		await expect(createGitStatus(nonCtx).execute("call", {})).rejects.toThrow(/Not a git repository/);
		rmSync(nonRepo, { recursive: true, force: true });
	});
});

describe("git_diff", () => {
	let dir: string;
	let ctx: ToolContext;

	beforeEach(() => {
		dir = setupRepo();
		ctx = makeCtx(dir);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns '(no changes)' on a clean tree", async () => {
		const result = await createGitDiff(ctx).execute("call", {});
		expect((result.content[0] as { type: "text"; text: string }).text).toBe("(no changes)");
	});

	it("shows working-tree diffs by default", async () => {
		writeFileSync(join(dir, "README.md"), "# initial\n# additional line\n");
		const result = await createGitDiff(ctx).execute("call", {});
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("README.md");
		expect(text).toContain("+# additional line");
		expect(result.details.mode).toBe("working");
	});

	it("shows staged diffs when staged: true", async () => {
		writeFileSync(join(dir, "README.md"), "# initial\n# staged line\n");
		git("add README.md", dir);

		const working = await createGitDiff(ctx).execute("call", {});
		expect((working.content[0] as { type: "text"; text: string }).text).toBe("(no changes)");

		const staged = await createGitDiff(ctx).execute("call", { staged: true });
		expect((staged.content[0] as { type: "text"; text: string }).text).toContain("+# staged line");
		expect(staged.details.mode).toBe("staged");
	});

	it("rejects staged + ref together", async () => {
		await expect(createGitDiff(ctx).execute("call", { staged: true, ref: "HEAD" })).rejects.toThrow(
			/staged or ref, not both/,
		);
	});

	it("scopes to a path when given", async () => {
		writeFileSync(join(dir, "a.txt"), "a\n");
		writeFileSync(join(dir, "b.txt"), "b\n");
		git("add .", dir);
		git("commit -q -m '2nd'", dir);
		writeFileSync(join(dir, "a.txt"), "a-changed\n");
		writeFileSync(join(dir, "b.txt"), "b-changed\n");

		const result = await createGitDiff(ctx).execute("call", { path: "a.txt" });
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("a.txt");
		expect(text).not.toContain("b.txt");
	});
});

describe("git_log", () => {
	let dir: string;
	let ctx: ToolContext;

	beforeEach(() => {
		dir = setupRepo();
		writeFileSync(join(dir, "f.txt"), "1\n");
		git("add f.txt", dir);
		git("commit -q -m 'add f'", dir);
		writeFileSync(join(dir, "f.txt"), "2\n");
		git("commit -q -am 'change f'", dir);
		ctx = makeCtx(dir);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns oneline history by default", async () => {
		const result = await createGitLog(ctx).execute("call", {});
		expect(result.details.entries.length).toBe(3);
		expect(result.details.entries[0].subject).toBe("change f");
	});

	it("respects count", async () => {
		const result = await createGitLog(ctx).execute("call", { count: 1 });
		expect(result.details.entries.length).toBe(1);
	});

	it("filters by path", async () => {
		const result = await createGitLog(ctx).execute("call", { path: "f.txt" });
		expect(result.details.entries.every((e) => e.subject.includes("f"))).toBe(true);
		expect(result.details.entries.length).toBe(2);
	});
});
