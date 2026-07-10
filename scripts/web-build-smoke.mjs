#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

const REQUIRED_SCOPES = ["inference", "projects", "credits", "builds:read", "builds:write"];
const DEFAULT_PROMPT = "Build a tiny launch smoke page saying Codebase CLI web handoff works.";

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
	printHelp();
	process.exit(0);
}
if (opts.error) die(opts.error, 2);

const cli = opts.cli ?? defaultCliCommand();
const prompt = opts.prompt ?? DEFAULT_PROMPT;
const wait = opts.wait ?? true;

console.log(`CLI: ${cli.label}`);
const auth = await runCli(cli, ["auth", "status"], { timeoutMs: 15_000 });
process.stdout.write(auth.stdout);
process.stderr.write(auth.stderr);
if (auth.code !== 0) die("auth status failed; run `codebase auth login` first", auth.code || 1);

const scopes = parseScopes(auth.stdout);
const missing = REQUIRED_SCOPES.filter((scope) => !scopes.includes(scope));
if (missing.length) {
	const hint =
		"missing OAuth scopes: " +
		missing.join(", ") +
		"\nRun `codebase auth login` after the web OAuth seed with build scopes is deployed.";
	die(opts.dryRun ? `DRY RUN: ${hint}` : hint, 2);
}
if (opts.dryRun) {
	console.log("DRY RUN: auth scopes look ready; skipping web build request.");
	process.exit(0);
}

const buildArgs = ["project", "build"];
if (wait) buildArgs.push("--wait", "--timeout", String(opts.timeoutSeconds ?? 600));
buildArgs.push(prompt);

console.log(`\nRunning: ${cli.label} ${buildArgs.map(shellQuote).join(" ")}`);
const build = await runCli(cli, buildArgs, { timeoutMs: (opts.timeoutSeconds ?? 600) * 1000 + 30_000 });
process.stdout.write(build.stdout);
process.stderr.write(build.stderr);

if (build.code !== 0) {
	const combined = `${build.stdout}\n${build.stderr}`;
	if (/request failed:\s*402|payment challenge/i.test(combined)) {
		die(
			"web build OAuth reached the payment gate. Deploy the web x402 Bearer-token bypass, then retry.",
			build.code || 1,
		);
	}
	if (/builds:read|builds:write|Missing required scope|403/i.test(combined)) {
		die("web build rejected the token scopes. Re-run `codebase auth login` and retry.", build.code || 1);
	}
	die(`web build smoke failed with exit ${build.code}`, build.code || 1);
}

const session = build.stdout.match(/session:\s*(\S+)/)?.[1];
const preview = build.stdout.match(/preview:\s*(\S+)/)?.[1];
if (!session) die("build command exited 0 but did not print a session id", 1);
if (!/latest:\s+codebase project status latest/.test(build.stdout)) {
	die("build command exited 0 but did not print the local latest-handoff recovery hint", 1);
}
if (wait && !preview) die("build command exited 0 with --wait but did not print a preview URL", 1);

console.log("\nChecking latest handoff recovery...");
const latest = await runCli(cli, ["project", "status", "latest"], { timeoutMs: 60_000 });
process.stdout.write(latest.stdout);
process.stderr.write(latest.stderr);
if (latest.code !== 0) die(`latest handoff status failed with exit ${latest.code}`, latest.code || 1);
if (!latest.stdout.includes(session)) die(`latest handoff status did not reference session ${session}`, 1);

console.log("\nWEB BUILD SMOKE OK");
console.log(`session: ${session}`);
if (preview) console.log(`preview: ${preview}`);

function parseArgs(args) {
	const out = {};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--help" || arg === "-h") return { help: true };
		if (arg === "--dry-run") {
			out.dryRun = true;
			continue;
		}
		if (arg === "--no-wait") {
			out.wait = false;
			continue;
		}
		if (arg === "--wait") {
			out.wait = true;
			continue;
		}
		if (arg === "--cli") {
			out.cli = parseCli(valueAfter(args, ++i, "--cli"));
			continue;
		}
		if (arg.startsWith("--cli=")) {
			out.cli = parseCli(arg.slice("--cli=".length));
			continue;
		}
		if (arg === "--prompt") {
			out.prompt = valueAfter(args, ++i, "--prompt");
			continue;
		}
		if (arg.startsWith("--prompt=")) {
			out.prompt = arg.slice("--prompt=".length);
			continue;
		}
		if (arg === "--timeout") {
			const parsed = parsePositiveInt(valueAfter(args, ++i, "--timeout"));
			if (!parsed) return { error: "--timeout requires positive seconds" };
			out.timeoutSeconds = parsed;
			continue;
		}
		if (arg.startsWith("--timeout=")) {
			const parsed = parsePositiveInt(arg.slice("--timeout=".length));
			if (!parsed) return { error: "--timeout requires positive seconds" };
			out.timeoutSeconds = parsed;
			continue;
		}
		return { error: `unknown argument: ${arg}` };
	}
	return out;
}

function valueAfter(args, index, flag) {
	const value = args[index];
	if (!value) die(`${flag} requires a value`, 2);
	return value;
}

function defaultCliCommand() {
	const dist = resolve("dist/cli.js");
	if (!existsSync(dist)) die("dist/cli.js is missing; run `npm run build` first", 2);
	return { command: process.execPath, args: [dist], label: `node ${dist}` };
}

function parseCli(value) {
	const abs = resolve(value);
	if (value.endsWith(".js")) return { command: process.execPath, args: [abs], label: `node ${abs}` };
	return { command: value, args: [], label: value };
}

function runCli(cli, args, { timeoutMs }) {
	return new Promise((resolveRun) => {
		const child = spawn(cli.command, [...cli.args, ...args], {
			stdio: ["ignore", "pipe", "pipe"],
			env: process.env,
		});
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			stderr += `\nTimed out after ${Math.round(timeoutMs / 1000)}s\n`;
		}, timeoutMs);
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString("utf8");
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolveRun({ code: code ?? 1, stdout, stderr });
		});
		child.on("error", (err) => {
			clearTimeout(timer);
			resolveRun({ code: 1, stdout, stderr: `${stderr}${err.message}\n` });
		});
	});
}

function parseScopes(text) {
	const line = text.split(/\r?\n/).find((entry) => entry.trim().startsWith("scopes:"));
	if (!line) return [];
	return line.replace(/^\s*scopes:\s*/, "").split(/\s+/).filter(Boolean);
}

function parsePositiveInt(value) {
	const parsed = Number.parseInt(value, 10);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function shellQuote(value) {
	return /^[a-zA-Z0-9_./:=@-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

function die(message, code = 1) {
	console.error(message);
	process.exit(code);
}

function printHelp() {
	console.log(`usage: node scripts/web-build-smoke.mjs [--dry-run] [--cli PATH] [--prompt TEXT] [--timeout SECONDS] [--no-wait]

Run a launch smoke test for CLI OAuth -> codebase.design web build.

Options:
  --dry-run          check CLI auth/scopes, but do not start a web build
  --cli PATH         CLI binary or JS entrypoint (default: dist/cli.js)
  --prompt TEXT      prompt to send to the web builder
  --timeout SECONDS  max wait time for --wait builds (default: 600)
  --no-wait          only assert build acceptance/session id`);
}
