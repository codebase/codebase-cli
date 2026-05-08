import { describe, expect, it, vi } from "vitest";
import type { GlueClient } from "./client.js";
import { generateTitle, narrate, suggestFollowUps } from "./narration.js";

function fakeGlue(reply: string): GlueClient {
	return {
		fast: vi.fn(async () => reply),
		smart: vi.fn(async () => reply),
	} as unknown as GlueClient;
}

function failingGlue(): GlueClient {
	return {
		fast: vi.fn(async () => {
			throw new Error("network");
		}),
		smart: vi.fn(async () => {
			throw new Error("network");
		}),
	} as unknown as GlueClient;
}

describe("generateTitle", () => {
	it("returns the LLM title trimmed and unquoted", async () => {
		const glue = fakeGlue('"Add OAuth refresh"');
		await expect(generateTitle(glue, "implement OAuth refresh logic")).resolves.toBe("Add OAuth refresh");
	});

	it("clamps long titles to 50 chars with an ellipsis", async () => {
		const long = "A very long title ".repeat(10);
		const glue = fakeGlue(long);
		const title = await generateTitle(glue, "do something");
		expect(title.length).toBeLessThanOrEqual(50);
		expect(title.endsWith("…")).toBe(true);
	});

	it("falls back to the user message on LLM error", async () => {
		const glue = failingGlue();
		await expect(generateTitle(glue, "rebuild the parser")).resolves.toBe("rebuild the parser");
	});
});

describe("narrate", () => {
	it("returns trimmed narration without trailing punctuation", async () => {
		const glue = fakeGlue("Edited 3 files in src/auth.");
		await expect(narrate(glue, "user edited 3 auth files")).resolves.toBe("Edited 3 files in src/auth");
	});

	it("clamps narrations to 80 chars", async () => {
		const long = "A".repeat(200);
		const glue = fakeGlue(long);
		const out = await narrate(glue, "x");
		expect(out.length).toBeLessThanOrEqual(80);
	});

	it("falls back to 'Working' on empty input or LLM error", async () => {
		const glue = failingGlue();
		await expect(narrate(glue, "")).resolves.toBe("Working");
		await expect(narrate(glue, "doing things")).resolves.toBe("Working");
	});
});

describe("suggestFollowUps", () => {
	it("parses bullet list output", async () => {
		const glue = fakeGlue("- Run the tests\n- Review the diff\n- Open a PR");
		await expect(suggestFollowUps(glue, "added auth", ["src/auth.ts"])).resolves.toEqual([
			"Run the tests",
			"Review the diff",
			"Open a PR",
		]);
	});

	it("caps to three suggestions", async () => {
		const glue = fakeGlue("- one\n- two\n- three\n- four\n- five");
		const out = await suggestFollowUps(glue, "summary", []);
		expect(out).toHaveLength(3);
	});

	it("returns [] on LLM error", async () => {
		const glue = failingGlue();
		await expect(suggestFollowUps(glue, "summary", [])).resolves.toEqual([]);
	});
});
