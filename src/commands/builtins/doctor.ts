import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CredentialsStore } from "../../auth/credentials.js";
import { VERSION } from "../../version.js";
import type { Command } from "../types.js";

/**
 * /doctor — diagnose the install: runtime, credentials, config files,
 * MCP servers, search keys, storage. Each check is one ✓/✗/– line so a
 * support request can start with a paste of this output.
 */
export const doctor: Command = {
	name: "doctor",
	description: "Diagnose the installation: runtime, auth, config, MCP, storage.",
	handler: (_args, ctx) => {
		const lines: string[] = [`codebase ${VERSION} · doctor`];
		const home = join(homedir(), ".codebase");

		// Runtime
		const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
		lines.push(check(major >= 20, `node ${process.versions.node}`, "node ≥ 20 required"));

		// Credentials
		const credStore = new CredentialsStore();
		const creds = credStore.load();
		if (!creds) {
			lines.push(
				info(
					credStore.exists()
						? "credentials file present but unreadable/invalid"
						: "not signed in (env-key or BYOK mode)",
				),
			);
		} else if (credStore.isExpired(creds)) {
			lines.push(
				check(
					false,
					"",
					`credentials expired${creds.refreshToken ? " (will auto-refresh on next call)" : " — run codebase auth login"}`,
				),
			);
		} else {
			const until = creds.expiresAt ? ` until ${new Date(creds.expiresAt).toLocaleString()}` : "";
			lines.push(check(true, `signed in (${creds.source})${until}`, ""));
		}

		// Model resolution for this session
		lines.push(
			check(
				true,
				`model: ${ctx.state.model.name} (${ctx.state.model.provider}/${ctx.state.model.id}) via ${ctx.bundle.source}`,
				"",
			),
		);

		// Config files parse
		for (const path of [join(home, "config.json"), join(ctx.bundle.toolContext.cwd, ".codebase", "config.json")]) {
			if (!existsSync(path)) continue;
			lines.push(check(parses(path), `config ${path}`, `config ${path} is not valid JSON`));
		}
		for (const path of [join(home, "mcp.json"), join(ctx.bundle.toolContext.cwd, ".codebase", "mcp.json")]) {
			if (!existsSync(path)) continue;
			lines.push(check(parses(path), `mcp config ${path}`, `mcp config ${path} is not valid JSON`));
		}

		// MCP server status (live)
		for (const s of ctx.bundle.mcp.status()) {
			lines.push(check(s.connected, `mcp ${s.name}: ${s.toolCount} tools`, `mcp ${s.name}: ${s.error ?? "failed"}`));
		}

		// Web search keys
		const hasSearch = Boolean(process.env.TAVILY_API_KEY || process.env.BRAVE_API_KEY || process.env.SEARXNG_URL);
		lines.push(
			hasSearch
				? check(true, "web_search configured", "")
				: info("web_search unconfigured — set TAVILY_API_KEY, BRAVE_API_KEY, or SEARXNG_URL to enable"),
		);

		// Storage writable
		lines.push(
			check(writable(home), `${home} writable`, `${home} is not writable — sessions/credentials can't persist`),
		);

		// Sessions + skills + agents on disk
		lines.push(info(`sessions for this directory: ${ctx.bundle.sessions.list().length}`));
		const subagents = ctx.bundle.toolContext.subagentTypes ?? [];
		lines.push(info(`subagent types: ${subagents.map((t) => t.name).join(", ") || "none"}`));

		ctx.emit(lines.join("\n"));
		return { handled: true };
	},
};

function check(ok: boolean, okText: string, failText: string): string {
	return ok ? `  ✓ ${okText}` : `  ✗ ${failText}`;
}

function info(text: string): string {
	return `  – ${text}`;
}

function parses(path: string): boolean {
	try {
		JSON.parse(readFileSync(path, "utf8"));
		return true;
	} catch {
		return false;
	}
}

function writable(dir: string): boolean {
	try {
		accessSync(dir, constants.W_OK);
		return true;
	} catch {
		return false;
	}
}
