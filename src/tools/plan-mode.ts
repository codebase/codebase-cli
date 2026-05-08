import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, type TSchema, Type } from "typebox";
import type { ToolContext } from "./types.js";

const EnterParams = Type.Object({
	reason: Type.Optional(
		Type.String({
			description: "Why you're entering plan mode. Optional, shown in the result for the user.",
		}),
	),
});

export type EnterPlanModeParams = Static<typeof EnterParams>;

export interface EnterPlanModeDetails {
	active: boolean;
	reason: string | null;
}

const ENTER_DESCRIPTION = `Enter plan mode. While active, destructive tools (write_file, edit_file, multi_edit, notebook_edit, shell, git_commit, git_branch, enter_worktree, exit_worktree) will be BLOCKED at the permission gate — only read tools work.

Use this when the user asks for a complex multi-step change. The flow is:
1. enter_plan_mode (no args, optionally a reason)
2. Investigate freely with read_file, list_files, glob, grep, etc.
3. Produce a markdown plan as a regular assistant message.
4. Call exit_plan_mode with the plan as the argument. The user sees the plan in the result.
5. After exit, you have full tool access again to execute the plan.

Don't enter plan mode for trivial single-step changes — the gate just adds friction there. Don't try to write files while in plan mode; the gate will block and you'll have to retry without progress.`;

export function createEnterPlanMode(ctx: ToolContext): AgentTool<typeof EnterParams, EnterPlanModeDetails> {
	return {
		name: "enter_plan_mode",
		label: "Plan: enter",
		description: ENTER_DESCRIPTION,
		parameters: EnterParams,
		executionMode: "sequential",
		execute: async (_id, params) => {
			ctx.planMode.enter();
			const reason = params.reason?.trim() || null;
			return {
				content: [
					{
						type: "text",
						text: reason
							? `Entered plan mode (${reason}). Write/edit/shell tools are blocked until exit_plan_mode.`
							: "Entered plan mode. Write/edit/shell tools are blocked until exit_plan_mode.",
					},
				],
				details: { active: true, reason },
			};
		},
	};
}

const ExitParams = Type.Object({
	plan: Type.String({
		minLength: 1,
		description: "The markdown plan you've produced. The user sees this verbatim and can choose whether to continue.",
	}),
});

export type ExitPlanModeParams = Static<typeof ExitParams>;

export interface ExitPlanModeDetails {
	active: boolean;
	plan: string;
}

const EXIT_DESCRIPTION = `Exit plan mode and present your plan to the user.

Pass the markdown plan as 'plan'. The user sees it in the result and can either let you continue executing the plan, or interrupt with corrections. After this returns you have full tool access again.

Don't exit without a plan. Don't exit if you're still investigating — keep using read tools first.`;

export function createExitPlanMode(ctx: ToolContext): AgentTool<typeof ExitParams, ExitPlanModeDetails> {
	return {
		name: "exit_plan_mode",
		label: "Plan: exit",
		description: EXIT_DESCRIPTION,
		parameters: ExitParams,
		executionMode: "sequential",
		execute: async (_id, params) => {
			ctx.planMode.exit();
			return {
				content: [
					{
						type: "text",
						text: `Exited plan mode. Plan presented:\n\n${params.plan}\n\nFull tool access restored. Execute the plan in order; stop or revise if the user pushes back.`,
					},
				],
				details: { active: false, plan: params.plan },
			};
		},
	};
}

export function createPlanModeTools(ctx: ToolContext): AgentTool<TSchema>[] {
	return [createEnterPlanMode(ctx), createExitPlanMode(ctx)];
}
