import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BranchOutcome, cleanupTournament, mergeWinner, parseVerdict, runTournament } from "./tournament.js";
import { snapshotWorkingTree } from "./wip-snapshot.js";

function git(cmd: string, cwd: string): string {
	return execSync(`git ${cmd}`, { cwd, encoding: "utf8" });
}

function setupRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "tourney-"));
	git("init -q -b main", dir);
	git("config user.email t@t.test", dir);
	git("config user.name tester", dir);
	writeFileSync(join(dir, "README.md"), "# initial\n");
	git("add README.md", dir);
	git("commit -q -m initial", dir);
	return dir;
}

function fakeJudge(reply: string) {
	return { smart: async () => reply };
}

describe("parseVerdict", () => {
	const outcomes: BranchOutcome[] = [
		{ id: "A", summary: "", diff: "d", filesChanged: ["a.ts"] },
		{ id: "B", summary: "", diff: "d", filesChanged: ["b.ts"] },
	];

	it("parses a clean verdict and validates ids", () => {
		const v = parseVerdict(
			'{"winner":"B","ranking":[{"id":"B","rationale":"cleaner"},{"id":"A","rationale":"ok"}]}',
			outcomes,
		);
		expect(v.winnerId).toBe("B");
		expect(v.ranking[0]).toEqual({ id: "B", rationale: "cleaner" });
	});

	it("rejects an unknown winner id", () => {
		const v = parseVerdict('{"winner":"Z","ranking":[]}', outcomes);
		expect(v.winnerId).toBeNull();
	});

	it("falls back to the first viable attempt on garbage", () => {
		const v = parseVerdict("the model rambled with no json", outcomes);
		expect(v.winnerId).toBe("A");
	});
});

describe("runTournament (real worktrees)", () => {
	let dir: string;
	afterEach(() => rmSync(dir, { recursive: true, force: true }));
	beforeEach(() => {
		dir = setupRepo();
	});

	it("races contestants, captures diffs, judges, and merges the winner", async () => {
		// Mid-build state: an uncommitted change the contestants must inherit.
		writeFileSync(join(dir, "wip.txt"), "in progress\n");
		const snap = await snapshotWorkingTree(dir);

		// Each contestant writes a file named after its model so branches differ.
		const runContestant = async ({ worktreePath, model }: { worktreePath: string; model?: string }) => {
			writeFileSync(join(worktreePath, `${model}.ts`), `// by ${model}\n`);
			return { summary: `did work as ${model}` };
		};

		const outcome = await runTournament({
			task: "add a module",
			cwd: dir,
			baseSha: snap.sha,
			branches: [
				{ id: "A", model: "alpha" },
				{ id: "B", model: "beta" },
			],
			runContestant,
			judge: fakeJudge('{"winner":"B","ranking":[{"id":"B","rationale":"better"},{"id":"A","rationale":"fine"}]}'),
		});

		expect(outcome.branches).toHaveLength(2);
		// Each contestant inherited the mid-build wip.txt AND added its own file.
		const a = outcome.branches.find((b) => b.id === "A");
		expect(a?.filesChanged).toContain("alpha.ts");
		expect(outcome.verdict.winnerId).toBe("B");

		const winner = outcome.branches.find((b) => b.id === outcome.verdict.winnerId);
		const merge = await mergeWinner(dir, snap.sha, winner as BranchOutcome);
		expect(merge.applied).toBe(true);
		// Winner's file is now in the user's working tree; loser's is not.
		expect(existsSync(join(dir, "beta.ts"))).toBe(true);
		expect(existsSync(join(dir, "alpha.ts"))).toBe(false);
		// The in-progress file is still there, untouched.
		expect(readFileSync(join(dir, "wip.txt"), "utf8")).toBe("in progress\n");

		await cleanupTournament(dir, outcome.branches);
		// Every contestant's worktree checkout is gone (the empty .worktrees
		// parent may remain — git ignores empty dirs, so it's harmless).
		for (const b of outcome.branches) {
			if (b.worktree) expect(existsSync(b.worktree.path)).toBe(false);
		}
	});

	it("records a contestant's failure without sinking the others", async () => {
		const snap = await snapshotWorkingTree(dir);
		const runContestant = async ({ worktreePath, model }: { worktreePath: string; model?: string }) => {
			if (model === "bad") throw new Error("contestant exploded");
			writeFileSync(join(worktreePath, "good.ts"), "ok\n");
			return { summary: "ok" };
		};

		const outcome = await runTournament({
			task: "t",
			cwd: dir,
			baseSha: snap.sha,
			branches: [
				{ id: "A", model: "bad" },
				{ id: "B", model: "good" },
			],
			runContestant,
			judge: fakeJudge("{}"),
		});

		expect(outcome.branches.find((b) => b.id === "A")?.error).toMatch(/exploded/);
		// Single viable attempt wins without a judge call.
		expect(outcome.verdict.winnerId).toBe("B");
		await cleanupTournament(dir, outcome.branches);
	});
});
