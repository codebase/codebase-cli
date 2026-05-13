import { describe, expect, it, vi } from "vitest";
import { CommandRegistry } from "./registry.js";
import type { Command, CommandContext } from "./types.js";

function fakeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
	return {
		bundle: {} as CommandContext["bundle"],
		state: {} as CommandContext["state"],
		emit: vi.fn(),
		clearDisplay: vi.fn(),
		exit: vi.fn(),
		registry: new CommandRegistry(),
		switchModel: vi.fn(async () => {}),
		openModelPicker: vi.fn(),
		...overrides,
	};
}

const okCommand: Command = {
	name: "ok",
	description: "test",
	handler: (_args, ctx) => {
		ctx.emit("done");
		return { handled: true };
	},
};

describe("CommandRegistry", () => {
	it("registers and looks up by primary name", () => {
		const reg = new CommandRegistry();
		reg.register(okCommand);
		expect(reg.get("ok")).toBe(okCommand);
		expect(reg.get("/ok")).toBe(okCommand);
		expect(reg.get("OK")).toBe(okCommand);
	});

	it("registers aliases", () => {
		const reg = new CommandRegistry();
		reg.register({ ...okCommand, aliases: ["okay", "yes"] });
		expect(reg.get("okay")).toBeDefined();
		expect(reg.get("yes")).toBeDefined();
	});

	it("rejects duplicate registration", () => {
		const reg = new CommandRegistry();
		reg.register(okCommand);
		expect(() => reg.register(okCommand)).toThrow(/already registered/);
	});

	it("list returns deduplicated commands sorted by name", () => {
		const reg = new CommandRegistry();
		reg.register({ ...okCommand, name: "zee", aliases: ["z"] });
		reg.register({ ...okCommand, name: "alpha" });
		expect(reg.list().map((c) => c.name)).toEqual(["alpha", "zee"]);
	});

	it("dispatch returns handled=false for non-slash input", async () => {
		const reg = new CommandRegistry();
		const ctx = fakeCtx();
		const result = await reg.dispatch("regular text", ctx);
		expect(result.handled).toBe(false);
	});

	it("dispatch returns handled=false for bare slash", async () => {
		const reg = new CommandRegistry();
		const ctx = fakeCtx();
		const result = await reg.dispatch("/", ctx);
		expect(result.handled).toBe(false);
	});

	it("dispatches by slash name and forwards args", async () => {
		const handler = vi.fn(() => ({ handled: true }));
		const reg = new CommandRegistry();
		reg.register({ name: "echo", description: "", handler });
		const ctx = fakeCtx();

		await reg.dispatch("/echo hello world", ctx);
		expect(handler).toHaveBeenCalledWith("hello world", ctx);
	});

	it("emits a friendly message for unknown commands and marks handled", async () => {
		const reg = new CommandRegistry();
		const ctx = fakeCtx();
		const result = await reg.dispatch("/nope", ctx);
		expect(result.handled).toBe(true);
		expect(ctx.emit).toHaveBeenCalledWith(expect.stringMatching(/unknown command/));
	});

	it("suggests the closest command on a typo", async () => {
		const reg = new CommandRegistry();
		reg.register({ name: "compact", description: "", handler: () => ({ handled: true }) });
		const ctx = fakeCtx();
		await reg.dispatch("/conpact", ctx);
		expect(ctx.emit).toHaveBeenCalledWith(expect.stringMatching(/Did you mean \/compact\?/));
	});

	it("trims whitespace around the args", async () => {
		const handler = vi.fn(() => ({ handled: true }));
		const reg = new CommandRegistry();
		reg.register({ name: "x", description: "", handler });
		const ctx = fakeCtx();

		await reg.dispatch("/x    spacey  ", ctx);
		expect(handler).toHaveBeenCalledWith("spacey", ctx);
	});

	it("supports async handlers", async () => {
		const reg = new CommandRegistry();
		reg.register({
			name: "slow",
			description: "",
			handler: async () => {
				await new Promise((r) => setTimeout(r, 10));
				return { handled: true };
			},
		});
		const ctx = fakeCtx();
		const result = await reg.dispatch("/slow", ctx);
		expect(result.handled).toBe(true);
	});
});
