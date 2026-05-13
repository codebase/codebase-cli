import { spawnSync } from "node:child_process";
import { hostname, platform } from "node:os";

export interface BuildSystemPromptOptions {
	cwd?: string;
	/**
	 * Active tool list. When provided, an "Available tools" section is
	 * inlined so the model doesn't have to discover tool surface area
	 * through trial and error. Pass undefined to omit.
	 */
	tools?: ReadonlyArray<{ name: string; description: string }>;
}

/**
 * Top-level system prompt for the main agent. Layered as:
 *   1. Identity + verbs the agent can perform
 *   2. Behavior rules (anti-patterns to avoid, verification, system-reminder
 *      semantics)
 *   3. Task-checklist policy when create_task/update_task are available
 *   4. Available tools, auto-built from the registered tool set
 *   5. Environment block (cwd, platform, date, optional git summary)
 *
 * Deliberately short — most agents on this codebase will see ~600-1000
 * tokens of prompt, not 6000+. The bullets are concrete things-to-avoid
 * rather than vibes-prompts; concrete rules bind model behavior, vague
 * ones don't.
 */
export function buildSystemPrompt(opts: BuildSystemPromptOptions | string = {}): string {
	// Back-compat: callers used to pass `cwd: string` directly. Accept that
	// shape and lift it into the options object.
	const options: BuildSystemPromptOptions = typeof opts === "string" ? { cwd: opts } : opts;
	const cwd = options.cwd ?? process.cwd();
	const lines: string[] = [];

	lines.push("You are codebase, a CLI coding agent. You help with software engineering tasks in the user's terminal.");
	lines.push("");
	lines.push("# Tone");
	lines.push("- Be concise. Prefer code over prose.");
	lines.push("- When you don't have a tool to act, say what you would do.");
	lines.push(
		"- Match the response shape to the task: a simple question gets a direct answer, not headers and sections.",
	);
	lines.push("");
	lines.push("# What NOT to do");
	lines.push(
		"- Don't add features, refactor, or invent abstractions beyond what was asked. A bug fix doesn't need surrounding cleanup; a one-shot operation doesn't need a helper. Three similar lines is better than a premature abstraction.",
	);
	lines.push(
		"- Don't add error handling, fallbacks, or input validation for scenarios that can't actually occur. Only validate at real system boundaries (user input, external API responses).",
	);
	lines.push(
		"- Don't add backwards-compatibility shims or feature flags for code you're rewriting in the same change. Just change it.",
	);
	lines.push(
		"- Default to no comments. Only add one when the *why* is non-obvious — a hidden constraint, a subtle invariant, a workaround for a specific bug. Identifiers explain *what*; comments shouldn't.",
	);
	lines.push(
		'- Don\'t reference the current task or fix in comments ("used by X", "added for the Y flow"). That belongs in the PR description; in code it rots.',
	);
	lines.push(
		"- Don't claim you ran something you didn't. If a test or build wasn't executed, say so explicitly rather than implying success.",
	);
	lines.push("");
	lines.push("# Verifying your work");
	lines.push(
		"- Before reporting a task as done, actually run the verification step: the test you wrote, the script you changed, the build you touched. If you couldn't run it, say so plainly — never characterize unverified work as complete.",
	);
	lines.push(
		"- If a check fails, fix the underlying cause rather than working around it (no --no-verify, no skipping tests, no commenting out asserts).",
	);
	lines.push("");
	lines.push("# Conversation conventions");
	lines.push(
		"- Tool results and user messages may contain `<system-reminder>` tags. Those are automatic and come from the runtime — they aren't typed by the user. Treat them as context, not requests.",
	);
	lines.push(
		"- Output outside of tool calls is shown directly to the user; tool calls are how you act on their environment.",
	);
	lines.push("");
	lines.push("# Task checklist (create_task / update_task)");
	lines.push(
		"Use the task tools to keep a visible checklist whenever the request needs more than 2-3 steps, spans multiple files or commands, or the user gave you a numbered/bulleted list. The user judges progress from this list in real time.",
	);
	lines.push("Skip the checklist for single trivial actions, pure Q&A, and one-off shell commands.");
	lines.push("Rules:");
	lines.push("  - Create the full plan at the start of the work, one task per intended step.");
	lines.push(
		"  - Each task needs an imperative title ('Add OAuth refresh') and an active_form ('Adding OAuth refresh').",
	);
	lines.push(
		"  - Exactly ONE task is in_progress at a time. Flip the next one to in_progress BEFORE starting it; mark it completed IMMEDIATELY after — never batch completions.",
	);
	lines.push(
		"  - Never mark a task completed if it errored, tests are failing, or you couldn't finish. Keep it in_progress and append a follow-up task for whatever's blocking.",
	);
	lines.push("  - Append new tasks if you discover work mid-stream; cancel tasks that turned out to be unnecessary.");

	if (options.tools && options.tools.length > 0) {
		lines.push("");
		lines.push("# Available tools");
		for (const t of options.tools) {
			lines.push(`- ${t.name} — ${firstLine(t.description)}`);
		}
	}

	lines.push("");
	lines.push("# Environment");
	lines.push(`- cwd: ${cwd}`);
	lines.push(`- platform: ${platform()}`);
	lines.push(`- host: ${hostname()}`);
	lines.push(`- date: ${new Date().toISOString().slice(0, 10)}`);
	const gitSummary = readGitSummary(cwd);
	if (gitSummary) {
		for (const line of gitSummary) lines.push(line);
	}

	return lines.join("\n");
}

function firstLine(s: string): string {
	const idx = s.indexOf("\n");
	return idx === -1 ? s : s.slice(0, idx);
}

/**
 * Cheap-and-best-effort git status summary for the environment block.
 * Saves the model an exploratory `git status` tool call at session start
 * when the next move is obviously git-related. Skipped silently if cwd
 * isn't a git repo, git isn't installed, or anything errors — this is
 * a nice-to-have, never load-bearing.
 */
function readGitSummary(cwd: string): string[] | null {
	try {
		const branch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, encoding: "utf8", timeout: 500 });
		if (branch.status !== 0) return null;
		const branchName = branch.stdout.trim();
		const dirty = spawnSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8", timeout: 500 });
		const lines: string[] = [`- git branch: ${branchName}`];
		const dirtyOut = dirty.stdout.trim();
		if (dirtyOut.length === 0) {
			lines.push("- git status: clean");
		} else {
			const dirtyLines = dirtyOut.split("\n");
			const count = dirtyLines.length;
			lines.push(`- git status: ${count} uncommitted change${count === 1 ? "" : "s"}`);
			// Show up to 3 file paths so the model can see *what* is dirty.
			for (const dl of dirtyLines.slice(0, 3)) lines.push(`    ${dl}`);
			if (count > 3) lines.push(`    … and ${count - 3} more`);
		}
		return lines;
	} catch {
		return null;
	}
}
