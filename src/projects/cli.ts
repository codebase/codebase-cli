import { defaultDownloadPath, NotAuthenticatedError, ProjectClient, ProjectClientError } from "./client.js";
import type { PlatformProject } from "./types.js";

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
		switch (subcommand) {
			case "list":
			case "ls":
				return await listCmd(client, out);
			case "pull":
				return await pullCmd(client, argv[2], argv[3], out, err);
			default:
				err(`unknown subcommand: ${subcommand}`);
				err("usage: codebase project [list | pull <id> [dest]]");
				return 2;
		}
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

async function listCmd(client: ProjectClient, out: (msg: string) => void): Promise<number> {
	const projects = await client.list();
	if (projects.length === 0) {
		out("(no projects yet — build one at https://codebase.design or pull an existing one)");
		return 0;
	}

	out(`${projects.length} project${projects.length === 1 ? "" : "s"}:`);
	out("");
	for (const p of projects) {
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
	out(`unzip with:  unzip -d ./${projectId} ${result.path}`);
	return 0;
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
