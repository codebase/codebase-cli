import { NotAuthenticatedError, ProjectClient, ProjectClientError } from "../../projects/client.js";
import type { Command } from "../types.js";

export const projects: Command = {
	name: "projects",
	aliases: ["project"],
	description: "List your projects from codebase.design (requires sign-in via `codebase auth login`).",
	handler: async (_args, ctx) => {
		const client = new ProjectClient();
		if (!client.hasCredentials()) {
			ctx.emit(
				"not signed in. Run `codebase auth login` from a fresh terminal, then come back. " +
					"Env-var providers (ANTHROPIC_API_KEY etc.) work fine for inference but the projects " +
					"endpoint is gated on a codebase.design account.",
			);
			return { handled: true };
		}
		try {
			const list = await client.list();
			if (list.length === 0) {
				ctx.emit("(no projects yet — build one at https://codebase.design)");
				return { handled: true };
			}
			const lines = [`${list.length} project${list.length === 1 ? "" : "s"} on your account:`, ""];
			for (const p of list) {
				const tag = p.source === "storage-only" ? " [storage]" : "";
				const date = p.publishedAt ? ` · ${p.publishedAt.slice(0, 10)}` : "";
				lines.push(`  ${p.id}  ${p.title ?? "(untitled)"}${tag}${date}`);
			}
			lines.push("");
			lines.push("pull one with:  codebase project pull <id>");
			ctx.emit(lines.join("\n"));
		} catch (err) {
			if (err instanceof NotAuthenticatedError) {
				ctx.emit(err.message);
			} else if (err instanceof ProjectClientError) {
				ctx.emit(`/projects failed: ${err.message}`);
			} else {
				ctx.emit(`/projects failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		return { handled: true };
	},
};
