import { describe, expect, it, vi } from "vitest";
import type { SkillAsset } from "../skills/types.js";
import { CommandRegistry } from "./registry.js";
import { buildSkillCommands, expandSkillPrompt } from "./skill-commands.js";
import type { CommandContext } from "./types.js";

function skill(overrides: Partial<SkillAsset> = {}): SkillAsset {
	return {
		kind: "skill",
		id: "optimize",
		source: "user",
		name: "Optimize",
		description: "Make it fast.",
		systemPrompt: "Optimize the code.",
		...overrides,
	};
}

function makeCtx(status = "idle"): { ctx: CommandContext; submitted: string[]; emitted: string[] } {
	const submitted: string[] = [];
	const emitted: string[] = [];
	const ctx = {
		bundle: {
			submitUserPrompt: vi.fn(async (text: string) => {
				submitted.push(text);
				return { submitted: true };
			}),
		},
		state: { status },
		emit: (text: string) => emitted.push(text),
	} as unknown as CommandContext;
	return { ctx, submitted, emitted };
}

describe("expandSkillPrompt", () => {
	it("substitutes $ARGUMENTS when present", () => {
		expect(expandSkillPrompt("Optimize $ARGUMENTS now.", "src/hot.ts")).toBe("Optimize src/hot.ts now.");
	});

	it("appends args when no placeholder exists", () => {
		expect(expandSkillPrompt("Optimize the code.", "src/hot.ts")).toBe("Optimize the code.\n\nsrc/hot.ts");
	});

	it("returns the bare body when args are empty", () => {
		expect(expandSkillPrompt("Optimize the code.", "  ")).toBe("Optimize the code.");
	});
});

describe("buildSkillCommands", () => {
	it("bridges a skill into a command that submits the expanded prompt", async () => {
		const registry = new CommandRegistry();
		const [cmd] = buildSkillCommands([skill({ systemPrompt: "Do the thing to $ARGUMENTS." })], registry);
		const { ctx, submitted } = makeCtx();
		const result = await cmd.handler("a.ts", ctx);
		expect(result.handled).toBe(true);
		// submit is fire-and-forget — flush the microtask queue.
		await new Promise((r) => setImmediate(r));
		expect(submitted).toEqual(["Do the thing to a.ts."]);
	});

	it("skips skills whose id collides with a registered command", () => {
		const registry = new CommandRegistry();
		registry.register({ name: "optimize", description: "builtin", handler: () => ({ handled: true }) });
		expect(buildSkillCommands([skill()], registry)).toEqual([]);
	});

	it("skips skills with slash-unsafe ids", () => {
		const registry = new CommandRegistry();
		expect(buildSkillCommands([skill({ id: "has spaces" })], registry)).toEqual([]);
	});

	it("refuses to run while the agent is busy", async () => {
		const registry = new CommandRegistry();
		const [cmd] = buildSkillCommands([skill()], registry);
		const { ctx, submitted, emitted } = makeCtx("streaming");
		await cmd.handler("", ctx);
		expect(submitted).toEqual([]);
		expect(emitted[0]).toMatch(/busy/);
	});

	it("emits when an empty-bodied skill is invoked", async () => {
		const registry = new CommandRegistry();
		const [cmd] = buildSkillCommands([skill({ systemPrompt: "  " })], registry);
		const { ctx, submitted, emitted } = makeCtx();
		await cmd.handler("", ctx);
		expect(submitted).toEqual([]);
		expect(emitted[0]).toMatch(/empty body/);
	});
});
