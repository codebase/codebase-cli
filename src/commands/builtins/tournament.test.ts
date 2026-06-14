import { describe, expect, it } from "vitest";
import type { CommandContext } from "../types.js";
import { tournament } from "./tournament.js";

function makeCtx(withRunner: boolean): {
	ctx: CommandContext;
	calls: { task: string; count: number; models?: string[] }[];
	emits: string[];
} {
	const calls: { task: string; count: number; models?: string[] }[] = [];
	const emits: string[] = [];
	const ctx = {
		emit: (t: string) => emits.push(t),
		runTournament: withRunner
			? (task: string, opts: { count: number; models?: string[] }) => calls.push({ task, ...opts })
			: undefined,
	} as unknown as CommandContext;
	return { ctx, calls, emits };
}

describe("/tournament", () => {
	it("defaults to 3 contestants when no count is given", () => {
		const { ctx, calls } = makeCtx(true);
		tournament.handler("add pagination to the list", ctx);
		expect(calls).toEqual([{ task: "add pagination to the list", count: 3, models: undefined }]);
	});

	it("parses and clamps a leading count to 2..5", () => {
		const { ctx, calls } = makeCtx(true);
		tournament.handler("9 refactor the parser", ctx);
		expect(calls[0]).toMatchObject({ task: "refactor the parser", count: 5 });
	});

	it("treats a number-only arg as the task, not a count", () => {
		const { ctx, calls } = makeCtx(true);
		tournament.handler("42", ctx);
		expect(calls[0]).toMatchObject({ task: "42", count: 3 });
	});

	it("parses --models into one contestant per model", () => {
		const { ctx, calls } = makeCtx(true);
		tournament.handler("--models opus,sonnet,haiku fix the parser", ctx);
		expect(calls[0]).toEqual({ task: "fix the parser", count: 3, models: ["opus", "sonnet", "haiku"] });
	});

	it("supports --models=a,b syntax and ignores a leading digit as task text", () => {
		const { ctx, calls } = makeCtx(true);
		tournament.handler("--models=a,b 2fa support", ctx);
		expect(calls[0]).toEqual({ task: "2fa support", count: 2, models: ["a", "b"] });
	});

	it("rejects a single-model list", () => {
		const { ctx, calls, emits } = makeCtx(true);
		tournament.handler("--models solo do a thing", ctx);
		expect(calls).toHaveLength(0);
		expect(emits[0]).toMatch(/at least 2/);
	});

	it("caps the model list at 5", () => {
		const { ctx, calls } = makeCtx(true);
		tournament.handler("--models a,b,c,d,e,f,g build", ctx);
		expect(calls[0].models).toHaveLength(5);
		expect(calls[0].count).toBe(5);
	});

	it("shows usage when given no task", () => {
		const { ctx, emits, calls } = makeCtx(true);
		tournament.handler("", ctx);
		expect(calls).toHaveLength(0);
		expect(emits[0]).toMatch(/Usage/);
	});

	it("explains when the picker UI is unavailable", () => {
		const { ctx, emits } = makeCtx(false);
		tournament.handler("do a thing", ctx);
		expect(emits[0]).toMatch(/pi-tui/);
	});
});
