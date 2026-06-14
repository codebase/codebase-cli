import type { Usage } from "@earendil-works/pi-ai";
import { runGit } from "../tools/git/git-helpers.js";
import { createSubagentWorktree, discardWorktree, type SubagentWorktree } from "../tools/subagent-worktree.js";

/**
 * /tournament: race N agents on the same build task in isolated
 * worktrees, then let a judge rank the finished attempts so the user can
 * merge the winner. Each contestant branches from a working-tree snapshot
 * (see wip-snapshot) so mid-build state is preserved, edits to completion,
 * and its resulting diff is scored. Worktrees stay alive after the run so
 * the caller can merge the chosen one and discard the rest.
 */

export interface BranchSpec {
	/** Stable id used in the UI and judge ranking (e.g. "A", "B"). */
	id: string;
	/** Optional model override for this contestant; falls back to the parent. */
	model?: string;
}

export interface ContestantInput {
	worktreePath: string;
	task: string;
	model?: string;
	signal?: AbortSignal;
	onToolCall?: (tool: string) => void;
}

/** Runs one agent to completion in a worktree. Injected so the core stays testable. */
export type ContestantRunner = (input: ContestantInput) => Promise<{ summary: string; usage?: Usage }>;

/** Cheap-model judge: ranks finished attempts. Injected (e.g. glue.smart). */
export interface JudgeModel {
	smart(prompt: string, system?: string, signal?: AbortSignal): Promise<string>;
}

export interface BranchOutcome {
	id: string;
	model?: string;
	/** The contestant's final report. */
	summary: string;
	/** Unified diff of the worktree against the snapshot base (clipped for the judge). */
	diff: string;
	filesChanged: string[];
	error?: string;
	worktree?: SubagentWorktree;
}

export interface JudgeVerdict {
	winnerId: string | null;
	ranking: { id: string; rationale: string }[];
}

export interface TournamentOutcome {
	branches: BranchOutcome[];
	verdict: JudgeVerdict;
}

export interface RunTournamentOptions {
	task: string;
	cwd: string;
	/** Working-tree snapshot commit every contestant branches from. */
	baseSha: string;
	branches: BranchSpec[];
	runContestant: ContestantRunner;
	judge: JudgeModel;
	signal?: AbortSignal;
	onProgress?: (e: TournamentProgress) => void;
}

export type TournamentProgress =
	| { type: "branch_start"; id: string }
	| { type: "branch_tool"; id: string; tool: string }
	| { type: "branch_done"; id: string; filesChanged: number; error?: string }
	| { type: "judging" };

const MAX_DIFF_FOR_JUDGE = 6000;

const JUDGE_SYSTEM = `You are judging competing attempts at the same coding task. You receive the task and each attempt's summary + diff. Pick the attempt that best and most correctly accomplishes the task — favor working, complete, minimal changes over sprawling or broken ones. Output is parsed by a program.

Respond with JSON only:
{"winner":"<id or null if all failed>","ranking":[{"id":"<id>","rationale":"<one line>"}]}
Rank best-first. Give every attempt a one-line rationale.`;

export async function runTournament(opts: RunTournamentOptions): Promise<TournamentOutcome> {
	const { task, cwd, baseSha, branches, runContestant, judge, signal, onProgress } = opts;

	const outcomes = await Promise.all(
		branches.map(async (spec): Promise<BranchOutcome> => {
			onProgress?.({ type: "branch_start", id: spec.id });
			let worktree: SubagentWorktree | undefined;
			try {
				worktree = await createSubagentWorktree(cwd, signal, baseSha);
				const { summary } = await runContestant({
					worktreePath: worktree.path,
					task,
					model: spec.model,
					signal,
					onToolCall: (tool) => onProgress?.({ type: "branch_tool", id: spec.id, tool }),
				});
				const { diff, filesChanged } = await diffWorktree(worktree.path, baseSha, signal);
				onProgress?.({ type: "branch_done", id: spec.id, filesChanged: filesChanged.length });
				return { id: spec.id, model: spec.model, summary, diff, filesChanged, worktree };
			} catch (err) {
				const error = err instanceof Error ? err.message : String(err);
				onProgress?.({ type: "branch_done", id: spec.id, filesChanged: 0, error });
				return { id: spec.id, model: spec.model, summary: "", diff: "", filesChanged: [], error, worktree };
			}
		}),
	);

	onProgress?.({ type: "judging" });
	const verdict = await judgeOutcomes(task, outcomes, judge, signal);
	return { branches: outcomes, verdict };
}

/** Stage everything in the worktree and diff it against the snapshot base. */
async function diffWorktree(
	worktreePath: string,
	baseSha: string,
	signal?: AbortSignal,
): Promise<{ diff: string; filesChanged: string[] }> {
	await runGit(["add", "-A"], worktreePath, signal);
	const names = await runGit(["diff", "--cached", "--name-only", baseSha], worktreePath, signal);
	const filesChanged = names.stdout.trim().split("\n").filter(Boolean);
	const diff = await runGit(["diff", "--cached", "--binary", baseSha], worktreePath, signal);
	return { diff: diff.stdout, filesChanged };
}

async function judgeOutcomes(
	task: string,
	outcomes: BranchOutcome[],
	judge: JudgeModel,
	signal?: AbortSignal,
): Promise<JudgeVerdict> {
	const runnable = outcomes.filter((o) => !o.error && o.filesChanged.length > 0);
	// Nothing to judge — everyone errored or made no changes.
	if (runnable.length === 0) {
		return { winnerId: null, ranking: outcomes.map((o) => ({ id: o.id, rationale: o.error ?? "made no changes" })) };
	}
	// A single viable attempt wins by default — no need to spend a judge call.
	if (runnable.length === 1) {
		return { winnerId: runnable[0].id, ranking: [{ id: runnable[0].id, rationale: "only viable attempt" }] };
	}

	const sections = outcomes.map((o) => {
		if (o.error) return `### Attempt ${o.id}\nFAILED: ${o.error}`;
		const diff =
			o.diff.length > MAX_DIFF_FOR_JUDGE ? `${o.diff.slice(0, MAX_DIFF_FOR_JUDGE)}\n…(diff truncated)` : o.diff;
		return `### Attempt ${o.id}\nSummary: ${o.summary || "(none)"}\nFiles: ${o.filesChanged.join(", ") || "(none)"}\nDiff:\n${diff}`;
	});
	const prompt = `Task:\n${task}\n\n${sections.join("\n\n")}`;
	const reply = await judge.smart(prompt, JUDGE_SYSTEM, signal);
	return parseVerdict(reply, outcomes);
}

/** Parse the judge's JSON, falling back to the first viable attempt if it's unusable. */
export function parseVerdict(reply: string, outcomes: BranchOutcome[]): JudgeVerdict {
	const ids = new Set(outcomes.map((o) => o.id));
	const fallback = (): JudgeVerdict => {
		const first = outcomes.find((o) => !o.error && o.filesChanged.length > 0);
		return {
			winnerId: first?.id ?? null,
			ranking: outcomes.map((o) => ({
				id: o.id,
				rationale: o.error ? `failed: ${o.error}` : "judge response unparseable",
			})),
		};
	};
	const start = reply.indexOf("{");
	const end = reply.lastIndexOf("}");
	if (start === -1 || end <= start) return fallback();
	let parsed: { winner?: unknown; ranking?: unknown };
	try {
		parsed = JSON.parse(reply.slice(start, end + 1));
	} catch {
		return fallback();
	}
	// JSON parsed — trust it literally. An invalid/missing winner means "no
	// clear winner, let the user pick", NOT a silent fallback.
	const winner = typeof parsed.winner === "string" && ids.has(parsed.winner) ? parsed.winner : null;
	const ranking = Array.isArray(parsed.ranking)
		? parsed.ranking
				.filter((r): r is { id: string; rationale: string } => {
					const o = r as { id?: unknown; rationale?: unknown };
					return typeof o.id === "string" && ids.has(o.id);
				})
				.map((r) => ({ id: r.id, rationale: typeof r.rationale === "string" ? r.rationale : "" }))
		: [];
	return {
		winnerId: winner,
		ranking: ranking.length > 0 ? ranking : outcomes.map((o) => ({ id: o.id, rationale: "" })),
	};
}

/**
 * Apply the winning worktree's diff onto the user's working tree. The
 * user's tree equals the snapshot base, so the patch applies cleanly.
 * Returns whether it landed; on failure the worktree is left for manual
 * recovery.
 */
export async function mergeWinner(
	cwd: string,
	baseSha: string,
	winner: BranchOutcome,
	signal?: AbortSignal,
): Promise<{ applied: boolean; error?: string }> {
	if (!winner.worktree) return { applied: false, error: "winner has no worktree" };
	const rootRes = await runGit(["rev-parse", "--show-toplevel"], cwd, signal);
	const root = rootRes.exitCode === 0 ? rootRes.stdout.trim() : cwd;
	const patchRes = await runGit(["diff", "--cached", "--binary", baseSha], winner.worktree.path, signal);
	const patch = patchRes.stdout;
	if (!patch.trim()) return { applied: true }; // nothing to apply
	const apply = await runGit(["apply", "--whitespace=nowarn"], root, signal, patch);
	if (apply.exitCode !== 0) {
		return { applied: false, error: apply.stderr.trim() || "git apply failed" };
	}
	return { applied: true };
}

/** Remove every contestant worktree. Call after the user has picked (or cancelled). */
export async function cleanupTournament(cwd: string, outcomes: BranchOutcome[]): Promise<void> {
	for (const o of outcomes) {
		if (o.worktree) await discardWorktree(cwd, o.worktree);
	}
}
