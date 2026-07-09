import { ConfigStore } from "../../config/store.js";
import type { PermissionPreview } from "../../permissions/store.js";
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
 *   /permissions suggest <cmd>   explain whether a shell command prompts
 *   /permissions simulate <plan> explain allow/prompt/block for a shell plan
 *
 * Patterns are `tool` (every call) or `tool:<arg-glob>` (e.g.
 * `shell:git push*`). Edits apply to the live session immediately and
 * persist to ~/.codebase/config.json.
 */
export const permissions: Command = {
	name: "permissions",
	aliases: ["allowed-tools"],
	description: "View or edit tool-permission rules. /permissions [allow|deny|remove|shell|suggest|simulate].",
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

		if (action === "suggest") {
			suggestShellPermission(pattern, ctx);
			return { handled: true };
		}

		if (action === "simulate" || action === "preview") {
			simulateShellPermissions(pattern, ctx);
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

		ctx.emit(
			`Unknown subcommand "${sub}". Use: /permissions [allow|deny|remove <pattern>|shell|suggest <command>|simulate <plan>].`,
		);
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
	ctx.emit(
		"Run /permissions shell to inspect policy, /permissions suggest <command>, or /permissions simulate <plan>.",
	);
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
			"Preview one command with /permissions suggest <command>.",
			'Preview a multi-command shell plan with /permissions simulate "npm test && git status".',
		].join("\n"),
	);
}

function suggestShellPermission(command: string, ctx: Parameters<Command["handler"]>[1]): void {
	if (!command) {
		ctx.emit("Usage: /permissions suggest <shell command>");
		return;
	}

	const preview = ctx.bundle.permissions.preview("shell", { command });
	const lines = ["Shell permission suggestion:", `  command: ${command}`];
	appendSuggestionResult(lines, preview);
	ctx.emit(lines.join("\n"));
}

function simulateShellPermissions(input: string, ctx: Parameters<Command["handler"]>[1]): void {
	if (!input) {
		ctx.emit("Usage: /permissions simulate <shell command plan>");
		return;
	}

	const commands = splitShellPlan(input);
	if (commands.length === 0) {
		ctx.emit("Usage: /permissions simulate <shell command plan>");
		return;
	}

	const previews = commands.map((command) => ctx.bundle.permissions.preview("shell", { command }));
	const counts = { allow: 0, prompt: 0, block: 0 };
	const lines = ["Permission simulation:"];

	previews.forEach((preview, index) => {
		counts[preview.decision] += 1;
		lines.push(
			`  ${index + 1}. ${preview.decision.toUpperCase()} ${preview.risk} [${preview.source}] ${commands[index]}`,
		);
		appendSimulationDetails(lines, preview);
	});

	lines.push(`Summary: allow ${counts.allow}, prompt ${counts.prompt}, block ${counts.block}.`);
	ctx.emit(lines.join("\n"));
}

function appendSuggestionResult(lines: string[], preview: PermissionPreview): void {
	if (preview.decision === "block") {
		if (preview.source === "shell-validator") {
			lines.push(`  result: hard-blocked by shell validator (${displayReason(preview.reason ?? "unsafe command")})`);
			lines.push(
				"  suggestion: no allow rule is offered for hard-blocked commands; rewrite it to target a safe path.",
			);
		} else {
			lines.push("  result: blocked by a persisted deny rule.");
		}
		return;
	}

	if (preview.decision === "allow") {
		if (preview.source === "built-in-read-only") {
			lines.push("  result: already auto-allowed by the built-in shell policy.");
		} else if (preview.source === "allow-rule") {
			lines.push("  result: allowed by a persisted allow rule.");
		} else if (preview.source === "session-trust") {
			lines.push("  result: already allowed by session trust.");
		} else {
			lines.push(`  result: allowed (${preview.reason ?? preview.source}).`);
		}
		return;
	}

	if (preview.risk === "high") {
		lines.push(`  result: will prompt as high risk (${displayReason(preview.reason ?? "high-risk shell command")})`);
	} else {
		lines.push("  result: will prompt because it is not in the built-in auto-allow set.");
		if (preview.reason) lines.push(`  reason: ${displayReason(preview.reason)}`);
	}
	appendHumanGuidance(lines, preview, "suggest");
}

function appendSimulationDetails(lines: string[], preview: PermissionPreview): void {
	if (preview.reason) lines.push(`     reason: ${preview.reason}`);
	appendHumanGuidance(lines, preview, "simulate");
}

function appendHumanGuidance(lines: string[], preview: PermissionPreview, mode: "suggest" | "simulate"): void {
	if (preview.decision === "prompt" && preview.trustScope && preview.trustScope !== "shell") {
		lines.push(
			mode === "suggest"
				? `  session trust scope: ${preview.trustScope}`
				: `     trust scope: ${preview.trustScope}`,
		);
	}

	for (const item of preview.guidance ?? []) {
		if (item.startsWith("Safer path: ")) {
			lines.push(`${indent(mode)}safer path: ${item.slice("Safer path: ".length)}`);
		} else if (item.startsWith("Persist exact allow: ")) {
			lines.push(`${indent(mode)}persist exact allow: ${item.slice("Persist exact allow: ".length)}`);
		} else if (item.startsWith("Persist family allow: ")) {
			lines.push(`${indent(mode)}persist family allow: ${item.slice("Persist family allow: ".length)}`);
		} else if (item.startsWith("Persist family deny: ")) {
			lines.push(`${indent(mode)}persist family deny: ${item.slice("Persist family deny: ".length)}`);
		} else if (item.startsWith("Persist allow: ")) {
			lines.push(`${indent(mode)}persist allow rule: ${item.slice("Persist allow: ".length)}`);
		} else if (item.startsWith("Persist deny: ")) {
			const spacing = mode === "suggest" ? "  " : " ";
			lines.push(`${indent(mode)}persist deny rule:${spacing}${item.slice("Persist deny: ".length)}`);
		} else if (item.startsWith("No allow rule ")) {
			lines.push(`${indent(mode)}${lowerFirst(item)}`);
		} else if (item.startsWith("Use allow-once")) {
			lines.push(`${indent(mode)}suggestion: ${lowerFirst(item)}`);
		}
	}
}

function splitShellPlan(input: string): string[] {
	const commands: string[] = [];
	let current = "";
	let quote: "'" | '"' | null = null;
	let escaped = false;

	const push = () => {
		const command = current.trim();
		if (command) commands.push(command);
		current = "";
	};

	for (let i = 0; i < input.length; i += 1) {
		const ch = input[i];

		if (escaped) {
			current += ch;
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			current += ch;
			escaped = true;
			continue;
		}
		if (quote) {
			current += ch;
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			current += ch;
			continue;
		}
		if (ch === "\n" || ch === ";") {
			push();
			continue;
		}
		const next = input[i + 1];
		if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
			push();
			i += 1;
			continue;
		}
		current += ch;
	}
	push();
	return commands;
}

function displayReason(value: string): string {
	const stripped = value
		.replace(/^High risk: shell validator warning: /, "")
		.replace(/^High risk: shell validator will hard-block this command: /, "")
		.replace(/^High risk: /, "")
		.replace(/^Medium risk: /, "");
	return stripped.endsWith(".") ? stripped : `${stripped}.`;
}

function lowerFirst(value: string): string {
	return `${value.slice(0, 1).toLowerCase()}${value.slice(1)}`;
}

function indent(mode: "suggest" | "simulate"): string {
	return mode === "suggest" ? "  " : "     ";
}
