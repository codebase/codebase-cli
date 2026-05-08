import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import type { Diagnostic, LanguageChecker } from "./types.js";

const CHECKER_TIMEOUT_MS = 15_000;

interface ProcessResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

function runChild(
	cmd: string,
	args: string[],
	cwd: string,
	signal?: AbortSignal,
	envOverlay: Record<string, string> = {},
): Promise<ProcessResult> {
	return new Promise((resolve) => {
		const child = spawn(cmd, args, {
			cwd,
			env: { ...process.env, NO_COLOR: "1", ...envOverlay },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
		}, CHECKER_TIMEOUT_MS);
		const onAbort = () => child.kill("SIGTERM");
		signal?.addEventListener("abort", onAbort);

		const out: Buffer[] = [];
		const err: Buffer[] = [];
		child.stdout?.on("data", (b: Buffer) => out.push(b));
		child.stderr?.on("data", (b: Buffer) => err.push(b));
		child.on("error", (e) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve({ stdout: "", stderr: e.message, exitCode: 1 });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve({
				stdout: Buffer.concat(out).toString("utf8"),
				stderr: Buffer.concat(err).toString("utf8"),
				exitCode: timedOut ? -1 : (code ?? 1),
			});
		});
	});
}

async function commandExists(cmd: string): Promise<boolean> {
	const which = process.platform === "win32" ? "where" : "which";
	const result = await runChild(which, [cmd], process.cwd());
	return result.exitCode === 0;
}

// ─── Go ───────────────────────────────────────────────────────

export const goVetChecker: LanguageChecker = {
	name: "go vet",
	extensions: [".go"],
	detect: async (cwd) => existsSync(join(cwd, "go.mod")),
	run: async (cwd, _files, signal) => {
		const r = await runChild("go", ["vet", "./..."], cwd, signal);
		return parseGoVet(r.stderr || r.stdout, cwd);
	},
};

export function parseGoVet(output: string, cwd: string): Diagnostic[] {
	const diags: Diagnostic[] = [];
	for (const raw of output.split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("# ")) continue;
		// Format: "path/to/file.go:LINE:COL: message" or "path/to/file.go:LINE: message"
		const match = /^(.+?\.go):(\d+):(?:(\d+):)?\s*(.+)$/.exec(line);
		if (!match) continue;
		const [, file, lineStr, colStr, message] = match;
		diags.push({
			file: toRelative(cwd, file),
			line: Number.parseInt(lineStr, 10),
			column: colStr ? Number.parseInt(colStr, 10) : undefined,
			severity: "error",
			message,
			source: "go vet",
		});
	}
	return diags;
}

// ─── TypeScript (tsc) ─────────────────────────────────────────

export const tscChecker: LanguageChecker = {
	name: "tsc",
	extensions: [".ts", ".tsx"],
	detect: async (cwd) => existsSync(join(cwd, "tsconfig.json")),
	run: async (cwd, _files, signal) => {
		const tscBin = await resolveTsc(cwd);
		if (!tscBin) return [];
		const r = await runChild(tscBin.cmd, [...tscBin.args, "--noEmit", "--pretty", "false"], cwd, signal);
		return parseTsc(r.stdout, cwd);
	},
};

interface TscBin {
	cmd: string;
	args: string[];
}

async function resolveTsc(cwd: string): Promise<TscBin | null> {
	const local = join(cwd, "node_modules", ".bin", "tsc");
	if (existsSync(local)) return { cmd: local, args: [] };
	if (await commandExists("tsc")) return { cmd: "tsc", args: [] };
	if (await commandExists("npx")) return { cmd: "npx", args: ["--no-install", "tsc"] };
	return null;
}

export function parseTsc(output: string, cwd: string): Diagnostic[] {
	const diags: Diagnostic[] = [];
	// Format: "path/to/file.ts(LINE,COL): error TSxxxx: message"
	const pattern = /^(.+?\.tsx?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/;
	for (const raw of output.split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		const match = pattern.exec(line);
		if (!match) continue;
		const [, file, lineStr, colStr, sev, code, message] = match;
		diags.push({
			file: toRelative(cwd, file),
			line: Number.parseInt(lineStr, 10),
			column: Number.parseInt(colStr, 10),
			severity: sev === "warning" ? "warning" : "error",
			message: `${code}: ${message}`,
			source: "tsc",
		});
	}
	return diags;
}

// ─── Pyright ──────────────────────────────────────────────────

export const pyrightChecker: LanguageChecker = {
	name: "pyright",
	extensions: [".py"],
	detect: async () => commandExists("pyright"),
	run: async (cwd, files, signal) => {
		if (files.length === 0) return [];
		const r = await runChild("pyright", ["--outputjson", ...files], cwd, signal);
		return parsePyright(r.stdout, cwd);
	},
};

export function parsePyright(output: string, cwd: string): Diagnostic[] {
	if (!output.trim()) return [];
	let parsed: PyrightOutput;
	try {
		parsed = JSON.parse(output) as PyrightOutput;
	} catch {
		return [];
	}
	const diags: Diagnostic[] = [];
	for (const d of parsed.generalDiagnostics ?? []) {
		// pyright uses 0-based line/column; bump to 1-based for consistency.
		diags.push({
			file: toRelative(cwd, d.file),
			line: (d.range?.start.line ?? 0) + 1,
			column: (d.range?.start.character ?? 0) + 1,
			severity: d.severity === "warning" ? "warning" : d.severity === "information" ? "info" : "error",
			message: d.message,
			source: "pyright",
		});
	}
	return diags;
}

interface PyrightOutput {
	generalDiagnostics?: Array<{
		file: string;
		severity: string;
		message: string;
		range?: { start: { line: number; character: number } };
	}>;
}

// ─── ESLint ───────────────────────────────────────────────────

export const eslintChecker: LanguageChecker = {
	name: "eslint",
	extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
	detect: async (cwd) =>
		existsSync(join(cwd, "eslint.config.js")) ||
		existsSync(join(cwd, "eslint.config.mjs")) ||
		existsSync(join(cwd, ".eslintrc.js")) ||
		existsSync(join(cwd, ".eslintrc.json")) ||
		existsSync(join(cwd, ".eslintrc.cjs")),
	run: async (cwd, files, signal) => {
		if (files.length === 0) return [];
		const local = join(cwd, "node_modules", ".bin", "eslint");
		const cmd = existsSync(local) ? local : "eslint";
		const r = await runChild(cmd, ["--format", "json", ...files], cwd, signal);
		return parseEslint(r.stdout, cwd);
	},
};

export function parseEslint(output: string, cwd: string): Diagnostic[] {
	if (!output.trim()) return [];
	let parsed: EslintOutput;
	try {
		parsed = JSON.parse(output) as EslintOutput;
	} catch {
		return [];
	}
	const diags: Diagnostic[] = [];
	for (const file of parsed) {
		for (const m of file.messages) {
			diags.push({
				file: toRelative(cwd, file.filePath),
				line: m.line ?? 1,
				column: m.column,
				severity: m.severity === 2 ? "error" : "warning",
				message: m.ruleId ? `${m.ruleId}: ${m.message}` : m.message,
				source: "eslint",
			});
		}
	}
	return diags;
}

type EslintOutput = Array<{
	filePath: string;
	messages: Array<{
		ruleId: string | null;
		severity: number;
		message: string;
		line?: number;
		column?: number;
	}>;
}>;

// ─── helpers ──────────────────────────────────────────────────

function toRelative(cwd: string, file: string): string {
	if (!file) return "";
	const rel = relative(cwd, file);
	if (rel.startsWith("..")) return file;
	return rel;
}

export const ALL_CHECKERS: readonly LanguageChecker[] = [tscChecker, goVetChecker, pyrightChecker, eslintChecker];
