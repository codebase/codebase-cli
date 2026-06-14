import { describe, expect, it } from "vitest";
import type { CommandContext } from "../types.js";
import { tournament } from "./tournament.js";

function makeCtx(withRunner: boolean): {
	ctx: CommandContext;
	calls: { task: string; count: number }[];
	emits: string[];
} {
	const calls: { task: string; count: number }[] = [];
	const emits: string[] = [];
	const ctx = {
		emit: (t: string) => emits.push(t),
		runTournament: withRunner ? (task: string, count: number) => calls.push({ task, count }) : undefined,
	} as unknown as CommandContext;
	return { ctx, calls, emits };
}

describe("/tournament", () => {
	it("defaults to 3 contestants when no count is given", () => {
		const { ctx, calls } = makeCtx(true);
		tournament.handler("add pagination to the list", ctx);
		expect(calls).toEqual([{ task: "add pagination to the list", count: 3 }]);
	});

	it("parses and clamps a leading count to 2..5", () => {
		const { ctx, calls } = makeCtx(true);
		tournament.handler("9 refactor the parser", ctx);
		expect(calls[0]).toEqual({ task: "refactor the parser", count: 5 });
	});

	it("treats a number-only arg as the task, not a count", () => {
		const { ctx, calls } = makeCtx(true);
		tournament.handler("42", ctx);
		// "42" alone has no task after it, so it stays the task with default count.
		expect(calls[0]).toEqual({ task: "42", count: 3 });
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
