import { describe, expect, it } from "vitest";
import { PlanModeStore } from "../plan/store.js";
import { UserQueryStore } from "../user-queries/store.js";
import { FileStateCache } from "./file-state-cache.js";
import { createEnterPlanMode, createExitPlanMode } from "./plan-mode.js";
import { TaskStore } from "./task-store.js";
import type { ToolContext } from "./types.js";

function makeCtx(): ToolContext {
	return {
		cwd: process.cwd(),
		fileStateCache: new FileStateCache(),
		tasks: new TaskStore(),
		userQueries: new UserQueryStore(),
		planMode: new PlanModeStore(),
		spawnSubagent: () => {
			throw new Error("not used in tests");
		},
	};
}

describe("enter_plan_mode", () => {
	it("flips PlanModeStore.active to true", async () => {
		const ctx = makeCtx();
		expect(ctx.planMode.isActive()).toBe(false);
		const result = await createEnterPlanMode(ctx).execute("e", {}, undefined);
		expect(ctx.planMode.isActive()).toBe(true);
		expect(result.details.active).toBe(true);
	});

	it("includes reason in the message when supplied", async () => {
		const ctx = makeCtx();
		const result = await createEnterPlanMode(ctx).execute("e", { reason: "complex refactor" }, undefined);
		expect((result.content[0] as { text: string }).text).toMatch(/complex refactor/);
		expect(result.details.reason).toBe("complex refactor");
	});

	it("is idempotent when already active", async () => {
		const ctx = makeCtx();
		await createEnterPlanMode(ctx).execute("e", {}, undefined);
		await createEnterPlanMode(ctx).execute("e2", {}, undefined);
		expect(ctx.planMode.isActive()).toBe(true);
	});
});

describe("exit_plan_mode", () => {
	it("flips PlanModeStore.active to false and surfaces the plan", async () => {
		const ctx = makeCtx();
		ctx.planMode.enter();
		const plan = "# Plan\n## Steps\n1. Do this\n2. Do that";
		const result = await createExitPlanMode(ctx).execute("x", { plan }, undefined);
		expect(ctx.planMode.isActive()).toBe(false);
		expect((result.content[0] as { text: string }).text).toContain("# Plan");
		expect(result.details.plan).toBe(plan);
	});

	it("works even if not currently in plan mode (defensive)", async () => {
		const ctx = makeCtx();
		expect(ctx.planMode.isActive()).toBe(false);
		const result = await createExitPlanMode(ctx).execute("x", { plan: "trivial" }, undefined);
		expect(ctx.planMode.isActive()).toBe(false);
		expect(result.details.active).toBe(false);
	});
});
