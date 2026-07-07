import { ConfigStore } from "../../config/store.js";
import { READ_ONLY_SHELL_PREFIXES } from "../../tools/permission.js";
import type { Command } from "../types.js";

/**
 * /permissions — view or edit the persisted allow/deny rules that gate
 * tool calls. Subcommands:
 *   /permissions                 list effective rules + session trusts
 *   /permissions allow <pat>     persist an allow rule (user layer)
 *   /permissions deny <pat>      persist a deny rule (user layer)
 *   /permissions remove <pat>    drop a user-layer rule
 *   /permissions shell           explain shell auto-allow / prompt policy
 *
 * Patterns are `tool` (every call) or `tool:<arg-glob>` (e.g.
 * `shell:git push*`). Edits apply to the live session immediately and
 * persist to ~/.codebase/config.json.
 */
export const permissions: Command = {
	name: "permissions",
	aliases: ["allowed-tools"],
	description: "View or edit tool-permission rules. /permissions [allow|deny|remove <pattern>|shell].",
	handler: (args, ctx) => {
		const config = new ConfigStore({ cwd: ctx.bundle.toolContext.cwd });
		const [sub, ...rest] = args.trim().split(/\s+/);
		const pattern = rest.join(" ").trim();

		if (!sub) {
			listRules(config, ctx);
			return { handled: true };
		}

		const action = sub.toLowerCase();
		if (action === "shell") {
			listShellPolicy(ctx);
			return { handled: true };
		}

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

		ctx.emit(`Unknown subcommand "${sub}". Use: /permissions [allow|deny|remove <pattern>|shell].`);
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
	ctx.emit("Run /permissions shell to inspect shell auto-allow and validator policy.");
}

/** Re-read merged config and recompile the live matchers so edits apply now. */
function applyLive(config: ConfigStore, ctx: Parameters<Command["handler"]>[1]): void {
	ctx.bundle.permissions.setRules(config.allowPatterns(), config.denyPatterns());
}

function listShellPolicy(ctx: Parameters<Command["handler"]>[1]): void {
	const examples = READ_ONLY_SHELL_PREFIXES.slice(0, 36).join(", ");
	ctx.emit(
		[
			"Shell permission policy:",
			`  auto-allowed read-only prefixes (${READ_ONLY_SHELL_PREFIXES.length}): ${examples}, ...`,
			"  prompts: anything outside that list, unless allow/deny rules match first.",
			'  trust tool: shell trust is scoped to a command prefix, e.g. "git commit" becomes shell:git commit*.',
			"  hard blocks: rm -rf / or $HOME, rm -rf /*, fork bombs, mkfs, and raw writes to block devices.",
			"  warnings: sudo, curl|sh or wget|sh, chmod 777/a+w, git push --force, and broad parent-directory deletes.",
			"Edit persisted rules with /permissions allow|deny|remove <pattern> (e.g. allow shell:npm run build*).",
		].join("\n"),
	);
}
