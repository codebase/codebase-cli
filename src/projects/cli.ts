import { dirname, resolve } from "node:path";
import { defaultDownloadPath, NotAuthenticatedError, ProjectClient, ProjectClientError } from "./client.js";
import type { BuildStatusResponse, PlatformProject } from "./types.js";

const DEFAULT_LIST_LIMIT = 25;
const DEFAULT_BUILD_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_BUILD_POLL_MS = 2_000;

export interface ProjectCliOptions {
	stdout?: (msg: string) => void;
	stderr?: (msg: string) => void;
	client?: ProjectClient;
	sleep?: (ms: number) => Promise<void>;
}

/**
 * Dispatch a `codebase project …` subcommand. Returns the exit code
 * to surface from the parent process.
 *
 * Recognized argv (relative to the entry point — argv[0] is the
 * "project" word that the dispatcher already matched):
 *   project              → list (default)
 *   project list         → list
 *   project pull <id>    → pull project to ~/.codebase/pulls/<id>.zip
 *   project pull <id> <dest>  → pull to <dest>
 *   project build [opts] <prompt> → start a web build on codebase.design
 *   project status <session-id>   → poll a web build
 *   project preview <session-id>  → start/fetch a web preview
 *   project cancel <session-id>   → cancel a running web build
 */
export async function runProjectSubcommand(argv: string[], options: ProjectCliOptions = {}): Promise<number> {
	const out = options.stdout ?? ((m) => process.stdout.write(`${m}\n`));
	const err = options.stderr ?? ((m) => process.stderr.write(`${m}\n`));
	const client = options.client ?? new ProjectClient();
	const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

	const subcommand = argv[1] ?? "list";

	try {
		if (subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
			printProjectHelp(out);
			return 0;
		}
		if (subcommand === "pull") return await pullCmd(client, argv[2], argv[3], out, err);
		if (subcommand === "build") return await buildCmd(client, argv.slice(2), out, err, sleep);
		if (subcommand === "status") return await statusCmd(client, argv[2], out, err);
		if (subcommand === "preview") return await previewCmd(client, argv[2], out, err);
		if (subcommand === "cancel") return await cancelCmd(client, argv[2], out, err);
		if (subcommand === "list" || subcommand === "ls" || isListFlag(subcommand)) {
			const args = subcommand === "list" || subcommand === "ls" ? argv.slice(2) : argv.slice(1);
			const opts = parseListOptions(args);
			if (opts.error) {
				err(opts.error);
				return 2;
			}
			return await listCmd(client, opts, out);
		}
		err(`unknown subcommand: ${subcommand}`);
		err("usage: codebase project [list | pull <id> [dest]]");
		return 2;
	} catch (e) {
		if (e instanceof NotAuthenticatedError) {
			err(e.message);
			return 1;
		}
		if (e instanceof ProjectClientError) {
			err(`error: ${e.message}`);
			if (e.status === 402) {
				err(
					"hint: codebase.design returned a payment challenge before accepting OAuth. Run `codebase auth login`; if this persists, the web build OAuth gate needs to be deployed.",
				);
			}
			if (e.status === 403) {
				err("hint: run `codebase auth login` again so the CLI can request builds:read/builds:write.");
			}
			return e.status === 404 ? 4 : 1;
		}
		err(`error: ${e instanceof Error ? e.message : String(e)}`);
		return 1;
	}
}

interface ListOptions {
	all?: boolean;
	limit: number;
	error?: string;
}

function parseListOptions(args: string[]): ListOptions {
	let all = false;
	let limit = DEFAULT_LIST_LIMIT;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--all") {
			all = true;
			continue;
		}
		if (arg === "--limit") {
			const value = args[i + 1];
			if (!value) return { limit, error: "--limit requires a positive integer" };
			const parsed = parseLimit(value);
			if (!parsed) return { limit, error: "--limit requires a positive integer" };
			limit = parsed;
			i++;
			continue;
		}
		if (arg.startsWith("--limit=")) {
			const parsed = parseLimit(arg.slice("--limit=".length));
			if (!parsed) return { limit, error: "--limit requires a positive integer" };
			limit = parsed;
			continue;
		}
		return { limit, error: `unknown flag: ${arg}` };
	}
	return { all, limit };
}

function parseLimit(value: string): number | undefined {
	const n = Number.parseInt(value, 10);
	return Number.isInteger(n) && n > 0 ? n : undefined;
}

function isListFlag(arg: string): boolean {
	return arg === "--all" || arg === "--limit" || arg.startsWith("--limit=");
}

async function listCmd(client: ProjectClient, opts: ListOptions, out: (msg: string) => void): Promise<number> {
	const projects = sortProjects([...(await client.list())]);
	if (projects.length === 0) {
		out("(no projects yet — build one at https://codebase.design or pull an existing one)");
		return 0;
	}

	const visible = opts.all ? projects : projects.slice(0, opts.limit);
	const suffix =
		visible.length < projects.length ? ` (showing ${visible.length}; use --all or --limit N to see more)` : "";
	out(`${projects.length} project${projects.length === 1 ? "" : "s"}${suffix}:`);
	out("");
	for (const p of visible) {
		out(formatProjectLine(p));
	}
	out("");
	out("pull one with:  codebase project pull <id>");
	return 0;
}

interface BuildOptions {
	prompt?: string;
	model?: string;
	scaffold?: string;
	projectId?: string;
	wait: boolean;
	timeoutMs: number;
	pollMs: number;
	error?: string;
	help?: boolean;
}

function parseBuildOptions(args: string[]): BuildOptions {
	const remaining: string[] = [];
	let model: string | undefined;
	let scaffold: string | undefined;
	let projectId: string | undefined;
	let wait = false;
	let timeoutMs = DEFAULT_BUILD_TIMEOUT_MS;
	let pollMs = DEFAULT_BUILD_POLL_MS;
	let literal = false;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (literal) {
			remaining.push(arg);
			continue;
		}
		if (arg === "--") {
			literal = true;
			continue;
		}
		if (arg === "--help" || arg === "-h") return { wait, timeoutMs, pollMs, help: true };
		if (arg === "--wait" || arg === "-w") {
			wait = true;
			continue;
		}
		if (arg === "--model") {
			const value = args[++i];
			if (!value) return { wait, timeoutMs, pollMs, error: "--model requires a value" };
			model = value;
			continue;
		}
		if (arg.startsWith("--model=")) {
			model = arg.slice("--model=".length);
			continue;
		}
		if (arg === "--scaffold") {
			const value = args[++i];
			if (!value) return { wait, timeoutMs, pollMs, error: "--scaffold requires a value" };
			scaffold = value;
			continue;
		}
		if (arg.startsWith("--scaffold=")) {
			scaffold = arg.slice("--scaffold=".length);
			continue;
		}
		if (arg === "--project" || arg === "--project-id") {
			const value = args[++i];
			if (!value) return { wait, timeoutMs, pollMs, error: `${arg} requires a value` };
			projectId = value;
			continue;
		}
		if (arg.startsWith("--project=")) {
			projectId = arg.slice("--project=".length);
			continue;
		}
		if (arg.startsWith("--project-id=")) {
			projectId = arg.slice("--project-id=".length);
			continue;
		}
		if (arg === "--timeout") {
			const value = args[++i];
			if (!value) return { wait, timeoutMs, pollMs, error: "--timeout requires seconds" };
			const parsed = parsePositiveSeconds(value);
			if (!parsed) return { wait, timeoutMs, pollMs, error: "--timeout requires positive seconds" };
			timeoutMs = parsed;
			continue;
		}
		if (arg.startsWith("--timeout=")) {
			const parsed = parsePositiveSeconds(arg.slice("--timeout=".length));
			if (!parsed) return { wait, timeoutMs, pollMs, error: "--timeout requires positive seconds" };
			timeoutMs = parsed;
			continue;
		}
		if (arg === "--poll-interval") {
			const value = args[++i];
			if (!value) return { wait, timeoutMs, pollMs, error: "--poll-interval requires seconds" };
			const parsed = parsePositiveSeconds(value);
			if (!parsed) return { wait, timeoutMs, pollMs, error: "--poll-interval requires positive seconds" };
			pollMs = parsed;
			continue;
		}
		if (arg.startsWith("--poll-interval=")) {
			const parsed = parsePositiveSeconds(arg.slice("--poll-interval=".length));
			if (!parsed) return { wait, timeoutMs, pollMs, error: "--poll-interval requires positive seconds" };
			pollMs = parsed;
			continue;
		}
		if (arg.startsWith("-")) return { wait, timeoutMs, pollMs, error: `unknown flag: ${arg}` };
		remaining.push(arg);
	}

	return {
		prompt: remaining.join(" ").trim() || undefined,
		model,
		scaffold,
		projectId,
		wait,
		timeoutMs,
		pollMs,
	};
}

function parsePositiveSeconds(value: string): number | undefined {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? Math.ceil(n * 1000) : undefined;
}

async function buildCmd(
	client: ProjectClient,
	args: string[],
	out: (msg: string) => void,
	err: (msg: string) => void,
	sleep: (ms: number) => Promise<void>,
): Promise<number> {
	const opts = parseBuildOptions(args);
	if (opts.help) {
		printBuildHelp(out);
		return 0;
	}
	if (opts.error) {
		err(opts.error);
		return 2;
	}
	if (!opts.prompt) {
		err("usage: codebase project build [--wait] [--model MODEL] [--project ID] <prompt>");
		return 2;
	}

	out("starting web build on codebase.design...");
	const started = await client.startBuild({
		prompt: opts.prompt,
		model: opts.model,
		scaffold: opts.scaffold,
		projectId: opts.projectId,
	});
	out("✓ build accepted");
	out(`  session: ${started.sessionId}`);
	out(`  project: ${started.projectId}`);
	if (started.model) out(`  model:   ${started.model}`);
	out(`  status:  ${started.status}`);
	out(`  poll:    codebase project status ${started.sessionId}`);
	out(`  events:  ${client.absoluteUrl(`/api/v1/builds/${started.sessionId}/events`)}`);
	if (!opts.wait) return 0;

	out("");
	out("waiting for build to finish...");
	const status = await waitForBuild(client, started.sessionId, opts.timeoutMs, opts.pollMs, sleep);
	printBuildStatus(status, out);
	if (status.status === "completed") {
		await printPreview(client, started.sessionId, out);
		return 0;
	}
	return status.status === "failed" ? 1 : 0;
}

async function waitForBuild(
	client: ProjectClient,
	sessionId: string,
	timeoutMs: number,
	pollMs: number,
	sleep: (ms: number) => Promise<void>,
): Promise<BuildStatusResponse> {
	const deadline = Date.now() + timeoutMs;
	let last: BuildStatusResponse | undefined;
	while (Date.now() <= deadline) {
		last = await client.getBuildStatus(sessionId);
		if (last.status !== "building") return last;
		await sleep(pollMs);
	}
	throw new ProjectClientError(
		`timed out waiting for build ${sessionId}; run \`codebase project status ${sessionId}\` to keep watching`,
	);
}

async function statusCmd(
	client: ProjectClient,
	sessionId: string | undefined,
	out: (msg: string) => void,
	err: (msg: string) => void,
): Promise<number> {
	if (!sessionId) {
		err("usage: codebase project status <session-id>");
		return 2;
	}
	const status = await client.getBuildStatus(sessionId);
	printBuildStatus(status, out);
	return status.status === "failed" ? 1 : 0;
}

async function previewCmd(
	client: ProjectClient,
	sessionId: string | undefined,
	out: (msg: string) => void,
	err: (msg: string) => void,
): Promise<number> {
	if (!sessionId) {
		err("usage: codebase project preview <session-id>");
		return 2;
	}
	return (await printPreview(client, sessionId, out)) ? 0 : 1;
}

async function cancelCmd(
	client: ProjectClient,
	sessionId: string | undefined,
	out: (msg: string) => void,
	err: (msg: string) => void,
): Promise<number> {
	if (!sessionId) {
		err("usage: codebase project cancel <session-id>");
		return 2;
	}
	const result = await client.cancelBuild(sessionId);
	out(`build ${result.sessionId}: ${result.status}`);
	out(result.stopped ? "✓ cancel requested" : "no active build was running");
	if (result.events) out(`events: ${client.absoluteUrl(result.events)}`);
	return 0;
}

function printBuildStatus(status: BuildStatusResponse, out: (msg: string) => void): void {
	out(`build ${status.sessionId}: ${status.status}`);
	if (status.projectId) out(`  project: ${status.projectId}`);
	if (status.model) out(`  model:   ${status.model}`);
	if (status.filesCreated?.length) out(`  files:   ${status.filesCreated.join(", ")}`);
	if (status.timeline?.length)
		out(`  events:  ${status.timeline.length} timeline item${status.timeline.length === 1 ? "" : "s"}`);
}

async function printPreview(client: ProjectClient, sessionId: string, out: (msg: string) => void): Promise<boolean> {
	const preview = await client.ensureBuildPreview(sessionId);
	if (!preview.ok || !preview.previewPath) {
		out(`preview unavailable${preview.reason ? `: ${preview.reason}` : ""}`);
		return false;
	}
	out(`preview: ${client.absoluteUrl(preview.previewPath)}`);
	return true;
}

async function pullCmd(
	client: ProjectClient,
	projectId: string | undefined,
	dest: string | undefined,
	out: (msg: string) => void,
	err: (msg: string) => void,
): Promise<number> {
	if (!projectId) {
		err("usage: codebase project pull <id> [dest]");
		return 2;
	}
	if (!client.hasCredentials()) {
		throw new NotAuthenticatedError();
	}
	const target = dest ?? defaultDownloadPath(projectId);
	out(`pulling ${projectId} → ${target}`);
	const result = await client.pull(projectId, dest);
	const kb = (result.bytes / 1024).toFixed(1);
	out(`✓ wrote ${result.path} (${kb} KB)`);
	out("");
	out(`unzip with:  unzip -d ${shellQuote(extractDir(result.path, projectId))} ${shellQuote(result.path)}`);
	return 0;
}

function sortProjects(projects: PlatformProject[]): PlatformProject[] {
	return projects.sort((a, b) => {
		const source = sourceRank(a) - sourceRank(b);
		if (source !== 0) return source;
		const titled = titleRank(a) - titleRank(b);
		if (titled !== 0) return titled;
		const date = projectTime(b) - projectTime(a);
		if (date !== 0) return date;
		return a.id.localeCompare(b.id);
	});
}

function sourceRank(p: PlatformProject): number {
	return p.source === "convex" ? 0 : 1;
}

function titleRank(p: PlatformProject): number {
	return p.title?.trim() ? 0 : 1;
}

function projectTime(p: PlatformProject): number {
	const raw = p.publishedAt ?? p.createdAt;
	const time = raw ? Date.parse(raw) : Number.NaN;
	return Number.isFinite(time) ? time : 0;
}

function extractDir(zipPath: string, projectId: string): string {
	const safe = projectId.replace(/[^a-zA-Z0-9._-]/g, "_");
	return resolve(dirname(zipPath), safe);
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function formatProjectLine(p: PlatformProject): string {
	const id = p.id.padEnd(36);
	const title = (p.title ?? "(untitled)").padEnd(28);
	const sourceTag = p.source === "storage-only" ? " [storage]" : "";
	const date = p.publishedAt
		? ` · published ${shortDate(p.publishedAt)}`
		: p.createdAt
			? ` · created ${shortDate(p.createdAt)}`
			: "";
	return `  ${id}  ${title}${sourceTag}${date}`;
}

function shortDate(iso: string): string {
	// Strip the time portion for the listing — full ISO is verbose
	// and the user just wants to scan dates.
	return iso.slice(0, 10);
}

function printProjectHelp(out: (msg: string) => void): void {
	out(
		"usage: codebase project [list | pull <id> [dest] | build [opts] <prompt> | status|preview|cancel <session-id>]",
	);
	out("");
	out("Commands:");
	out("  list          list your projects on codebase.design (default: 25)");
	out("  list --all    show every project");
	out("  list --limit N");
	out("                show at most N projects");
	out("  pull <id>     download a project ZIP");
	out("  build <prompt>");
	out("                start a web build on codebase.design");
	out("  status <id>   show a web build status");
	out("  preview <id>  start/fetch the web preview for a build");
	out("  cancel <id>   cancel a running web build");
}

function printBuildHelp(out: (msg: string) => void): void {
	out("usage: codebase project build [--wait] [--model MODEL] [--scaffold ID] [--project ID] <prompt>");
	out("alias: codebase web-build [--wait] [--model MODEL] [--scaffold ID] [--project ID] <prompt>");
	out("");
	out("Start an async web build on codebase.design using your OAuth session.");
	out("");
	out("Options:");
	out("  --wait, -w           poll until the build completes, then print preview URL");
	out("  --timeout SECONDS    max wait time with --wait (default: 600)");
	out("  --model MODEL        request a specific web build model");
	out("  --scaffold ID        request a specific web scaffold");
	out("  --project ID         continue/build against an existing project when supported by the web API");
}
