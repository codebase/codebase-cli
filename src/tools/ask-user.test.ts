import { describe, expect, it } from "vitest";
import { UserQueryStore } from "../user-queries/store.js";
import { createAskUser } from "./ask-user.js";
import { FileStateCache } from "./file-state-cache.js";
import { TaskStore } from "./task-store.js";
import type { ToolContext } from "./types.js";

function makeCtx(): ToolContext {
	return {
		cwd: process.cwd(),
		fileStateCache: new FileStateCache(),
		tasks: new TaskStore(),
		userQueries: new UserQueryStore(),
		spawnSubagent: () => {
			throw new Error("not used in tests");
		},
	};
}

describe("ask_user", () => {
	it("returns the user's typed answer", async () => {
		const ctx = makeCtx();
		const promise = createAskUser(ctx).execute("a", { question: "name?" }, undefined);
		// Resolve as the UI would
		ctx.userQueries.respond(ctx.userQueries.current()!.id, "halfaipg");
		const result = await promise;
		expect(result.details.answer).toBe("halfaipg");
		expect(result.details.matchedOption).toBeNull();
	});

	it("matches a 1-based option number to the option text", async () => {
		const ctx = makeCtx();
		const promise = createAskUser(ctx).execute(
			"a",
			{ question: "which target?", options: ["staging", "production"] },
			undefined,
		);
		ctx.userQueries.respond(ctx.userQueries.current()!.id, "2");
		const result = await promise;
		expect(result.details.answer).toBe("2");
		expect(result.details.matchedOption).toBe("production");
	});

	it("matches an exact option text (case-insensitive)", async () => {
		const ctx = makeCtx();
		const promise = createAskUser(ctx).execute("a", { question: "?", options: ["yes", "no"] }, undefined);
		ctx.userQueries.respond(ctx.userQueries.current()!.id, "YES");
		const result = await promise;
		expect(result.details.matchedOption).toBe("yes");
	});

	it("leaves matchedOption null for free-form responses", async () => {
		const ctx = makeCtx();
		const promise = createAskUser(ctx).execute("a", { question: "?", options: ["a", "b"] }, undefined);
		ctx.userQueries.respond(ctx.userQueries.current()!.id, "neither");
		const result = await promise;
		expect(result.details.matchedOption).toBeNull();
		expect(result.details.answer).toBe("neither");
	});

	it("propagates cancellation as a rejection", async () => {
		const ctx = makeCtx();
		const promise = createAskUser(ctx).execute("a", { question: "?" }, undefined);
		ctx.userQueries.cancel(ctx.userQueries.current()!.id);
		await expect(promise).rejects.toThrow(/cancelled/);
	});
});
