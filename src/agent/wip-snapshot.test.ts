import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { snapshotWorkingTree } from "./wip-snapshot.js";

function git(cmd: string, cwd: string): string {
	return execSync(`git ${cmd}`, { cwd, encoding: "utf8" });
}

function setupRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "wip-snap-"));
	git("init -q -b main", dir);
	git("config user.email t@t.test", dir);
	git("config user.name tester", dir);
	writeFileSync(join(dir, "README.md"), "# initial\n");
	git("add README.md", dir);
	git("commit -q -m initial", dir);
	return dir;
}

/** List paths present in a commit's tree. */
function treePaths(sha: string, cwd: string): string[] {
	return git(`ls-tree -r --name-only ${sha}`, cwd).trim().split("\n").filter(Boolean);
}

describe("snapshotWorkingTree", () => {
	let dir: string;
	afterEach(() => rmSync(dir, { recursive: true, force: true }));
	beforeEach(() => {
		dir = setupRepo();
	});

	it("captures tracked modifications and untracked files without disturbing the index", async () => {
		writeFileSync(join(dir, "README.md"), "# changed\n"); // modify tracked
		writeFileSync(join(dir, "new.ts"), "export const x = 1;\n"); // untracked
		// Stage something specific so we can prove the user's index is untouched.
		writeFileSync(join(dir, "staged.ts"), "staged\n");
		git("add staged.ts", dir);
		const indexBefore = git("status --porcelain", dir);

		const snap = await snapshotWorkingTree(dir);

		// The snapshot tree contains every working-tree file, committed or not.
		const paths = treePaths(snap.sha, dir);
		expect(paths).toContain("README.md");
		expect(paths).toContain("new.ts");
		expect(paths).toContain("staged.ts");
		// The modified README's new bytes are in the snapshot.
		expect(git(`show ${snap.sha}:README.md`, dir)).toBe("# changed\n");
		// The user's index/worktree is exactly as it was.
		expect(git("status --porcelain", dir)).toBe(indexBefore);
		expect(snap.clean).toBe(false);
	});

	it("reports clean when the working tree matches HEAD", async () => {
		const snap = await snapshotWorkingTree(dir);
		expect(snap.clean).toBe(true);
		expect(snap.headSha).toBeTruthy();
	});

	it("respects .gitignore — ignored files don't enter the snapshot", async () => {
		writeFileSync(join(dir, ".gitignore"), "secret.txt\n");
		writeFileSync(join(dir, "secret.txt"), "shhh\n");
		const snap = await snapshotWorkingTree(dir);
		expect(treePaths(snap.sha, dir)).not.toContain("secret.txt");
	});

	it("throws on a repo with no commits", async () => {
		const empty = mkdtempSync(join(tmpdir(), "wip-empty-"));
		git("init -q -b main", empty);
		try {
			await expect(snapshotWorkingTree(empty)).rejects.toThrow(/no commits/);
		} finally {
			rmSync(empty, { recursive: true, force: true });
		}
	});
});
