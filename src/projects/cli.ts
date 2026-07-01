import { dirname, resolve } from "node:path";
import { defaultDownloadPath, NotAuthenticatedError, ProjectClient, ProjectClientError } from "./client.js";
import type { PlatformProject } from "./types.js";

const DEFAULT_LIST_LIMIT = 25;

export interface ProjectCliOptions {
	stdout?: (msg: string) => void;
	stderr?: (msg: string) => void;
	client?: ProjectClient;
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
 */
export async function runProjectSubcommand(argv: string[], options: ProjectCliOptions = {}): Promise<number> {
	const out = options.stdout ?? ((m) => process.stdout.write(`${m}\n`));
	const err = options.stderr ?? ((m) => process.stderr.write(`${m}\n`));
	const client = options.client ?? new ProjectClient();

	const subcommand = argv[1] ?? "list";

	try {
		if (subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
			printProjectHelp(out);
			return 0;
		}
		if (subcommand === "pull") return await pullCmd(client, argv[2], argv[3], out, err);
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
	out("usage: codebase project [list | pull <id> [dest]]");
	out("");
	out("Commands:");
	out("  list          list your projects on codebase.design (default: 25)");
	out("  list --all    show every project");
	out("  list --limit N");
	out("                show at most N projects");
	out("  pull <id>     download a project ZIP");
}
