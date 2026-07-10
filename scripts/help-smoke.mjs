#!/usr/bin/env node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repo = resolve(__dirname, "..");
const cli = process.env.CODEBASE_HELP_SMOKE_CLI ?? join(repo, "dist", "cli.js");

const commands = [
	{ args: ["--help"], expect: "sign in via codebase.design browser OAuth" },
	{ args: ["help"], expect: "Help topics:" },
	{ args: ["help", "permissions"], expect: "/permissions suggest <command>" },
	{ args: ["help", "web-build"], expect: "codebase web-build" },
	{ args: ["help", "bench"], expect: "codebase bench run --scenario all" },
	{ args: ["auth", "--help"], expect: "usage: codebase auth" },
	{ args: ["project", "--help"], expect: "usage: codebase project" },
	{ args: ["project", "build", "--help"], expect: "alias: codebase web-build" },
	{ args: ["web-build", "--help"], expect: "alias: codebase web-build" },
	{ args: ["ssh", "--help"], expect: "codebase ssh add" },
	{ args: ["usage", "--help"], expect: "usage: codebase usage" },
	{ args: ["doctor", "--help"], expect: "usage: codebase doctor" },
	{ args: ["director", "--help"], expect: "usage: codebase director" },
	{ args: ["mcp", "--help"], expect: "usage: codebase mcp" },
	{ args: ["receipt", "--help"], expect: "usage: codebase receipt" },
	{ args: ["bench", "--help"], expect: "usage: codebase bench" },
	{ args: ["bench", "run", "--help"], expect: "usage: codebase bench run" },
	{ args: ["bench", "report", "--help"], expect: "usage: codebase bench report" },
	{ args: ["run", "--help"], expect: "usage: codebase run" },
	{ args: ["auto", "--help"], expect: "usage: codebase auto" },
	{ args: ["app-server", "--help"], expect: "usage: codebase app-server" },
	{ args: ["memory"], expect: "Inside `codebase`:" },
	{ args: ["permissions"], expect: "/permissions suggest <command>" },
	{ args: ["permissions", "suggest", "npm install"], expect: "persist exact allow: /permissions allow shell:npm install" },
	{ args: ["permissions", "simulate", "git status --short && sudo apt update"], expect: "Summary: allow 1, prompt 1, block 0." },
	{ args: ["agents"], expect: "/agents" },
	{ args: ["skills"], expect: "/skills" },
	{ args: ["tournament"], expect: "/tournament <task>" },
	{ args: ["context"], expect: "/context explain" },
	{ args: ["model", "--help"], expect: "/model <id>" },
	{ args: ["effort", "--help"], expect: "/effort low" },
	{ args: ["rewind", "--help"], expect: "/rewind <seq>" },
];

const home = mkdtempSync(join(tmpdir(), "codebase-help-smoke-home-"));
let failures = 0;

try {
	for (const command of commands) {
		const result = await run(command.args, home);
		const label = `codebase ${command.args.join(" ")}`.trim();
		const output = `${result.stdout}\n${result.stderr}`;
		if (result.timedOut) {
			failures++;
			console.error(`FAIL ${label}: timed out`);
			continue;
		}
		if (result.exitCode !== 0) {
			failures++;
			console.error(`FAIL ${label}: exit ${result.exitCode}\n${output.trim()}`);
			continue;
		}
		if (!output.includes(command.expect)) {
			failures++;
			console.error(`FAIL ${label}: missing "${command.expect}"\n${output.trim()}`);
			continue;
		}
		if (output.includes('"server_ready"') || output.includes("No LLM provider configured")) {
			failures++;
			console.error(`FAIL ${label}: appears to have entered a runtime mode\n${output.trim()}`);
			continue;
		}
		if (output.includes("codebase.foundation")) {
			failures++;
			console.error(`FAIL ${label}: references retired codebase.foundation domain\n${output.trim()}`);
			continue;
		}
		console.log(`ok ${label}`);
	}
} finally {
	rmSync(home, { recursive: true, force: true });
}

if (failures > 0) {
	console.error(`${failures} help smoke check${failures === 1 ? "" : "s"} failed`);
	process.exit(1);
}

function run(args, home) {
	return new Promise((resolveRun) => {
		const child = spawn(process.execPath, [cli, ...args], {
			cwd: repo,
			env: { ...process.env, HOME: home, CODEBASE_NO_NOTIFY: "1", NO_COLOR: "1" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
		}, 3000);
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			resolveRun({ stdout, stderr: `${stderr}${error.message}`, exitCode: 1, timedOut });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolveRun({ stdout, stderr, exitCode: code ?? 1, timedOut });
		});
	});
}
