import { ConfigStore } from "../../config/store.js";
import type { Command } from "../types.js";

/**
 * /permissions — view or edit the persisted allow/deny rules that gate
 * tool calls. Subcommands:
 *   /permissions                 list effective rules + session trusts
 *   /permissions allow <pat>     persist an allow rule (user layer)
 *   /permissions deny <pat>      persist a deny rule (user layer)
 *   /permissions remove <pat>    drop a user-layer rule
 *
 * Patterns are `tool` (every call) or `tool:<arg-glob>` (e.g.
 * `shell:git push*`). Edits apply to the live session immediately and
 * persist to ~/.codebase/config.json.
 */
export const permissions: Command = {
	name: "permissions",
	aliases: ["allowed-tools"],
	description: "View or edit tool-permission rules. /permissions [allow|deny|remove <pattern>].",
	handler: (args, ctx) => {
		const config = new ConfigStore({ cwd: ctx.bundle.toolContext.cwd });
		const [sub, ...rest] = args.trim().split(/\s+/);
		const pattern = rest.join(" ").trim();

		if (!sub) {
			listRules(config, ctx);
			return { handled: true };
		}

		const action = sub.toLowerCase();
		if (action === "allow" || action === "deny") {
			if (!pattern) {
				ctx.emit(`Usage: /permissions ${action} <pattern>   (e.g. ${action} shell:git push*)`);
				return { handled: true };
			}
			const added = config.addPermission(action, pattern);
			applyLive(config, ctx);
			ctx.emit(added ? `Added ${action} rule: ${pattern}` : `Already an ${action} rule: ${pattern}`);
			return { handled: true };
		}

		if (action === "remove" || action === "rm") {
			if (!pattern) {
				ctx.emit("Usage: /permissions remove <pattern>");
				return { handled: true };
			}
			const removed = config.removePermission(pattern);
			applyLive(config, ctx);
			ctx.emit(removed ? `Removed rule: ${pattern}` : `No user-layer rule matched: ${pattern}`);
			return { handled: true };
		}

		ctx.emit(`Unknown subcommand "${sub}". Use: /permissions [allow|deny|remove <pattern>].`);
		return { handled: true };
	},
};

function listRules(config: ConfigStore, ctx: Parameters<Command["handler"]>[1]): void {
	const allow = config.allowPatterns();
	const deny = config.denyPatterns();
	const trusted = ctx.bundle.permissions.listTrusted();

	ctx.emit("Permission rules (deny wins over allow):");
	ctx.emit(`  allow: ${allow.length ? allow.join(", ") : "(none — read-only tools are always allowed)"}`);
	ctx.emit(`  deny:  ${deny.length ? deny.join(", ") : "(none)"}`);
	if (trusted.tools.length || trusted.shellPrefixes.length) {
		const items = [...trusted.tools, ...trusted.shellPrefixes.map((p) => `shell:${p}*`)];
		ctx.emit(`  this session also trusts: ${items.join(", ")}`);
	}
	ctx.emit("Edit with /permissions allow|deny|remove <pattern> (e.g. allow shell:git status*).");
}

/** Re-read merged config and recompile the live matchers so edits apply now. */
function applyLive(config: ConfigStore, ctx: Parameters<Command["handler"]>[1]): void {
	ctx.bundle.permissions.setRules(config.allowPatterns(), config.denyPatterns());
}
