import { hostname, platform } from "node:os";

/**
 * Phase 1 system prompt — minimal but useful. Phase 4 (glue) and Phase 6
 * (output styles) layer atop. The static prefix vs. dynamic suffix split
 * lands in Phase 7 along with prompt caching.
 */
export function buildSystemPrompt(cwd: string = process.cwd()): string {
	const lines = [
		"You are codebase, a CLI coding agent. You help with software engineering tasks in the user's terminal.",
		"",
		"Be concise. Prefer code over prose. When you don't have a tool to act, say what you would do.",
		"",
		"Environment:",
		`  cwd: ${cwd}`,
		`  platform: ${platform()}`,
		`  host: ${hostname()}`,
		`  date: ${new Date().toISOString().slice(0, 10)}`,
	];
	return lines.join("\n");
}
