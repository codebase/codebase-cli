import { describe, expect, it, vi } from "vitest";
import type { GlueClient } from "../glue/client.js";
import {
	buildAgentPrompt,
	extractJson,
	generatePlan,
	generateQuestion,
	MAX_QUESTIONS,
	parseAnswer,
	revisePlan,
} from "./flow.js";
import { ANSWER_START_BUILDING, type PlanQuestion } from "./types.js";

function fakeGlue(reply: string): GlueClient {
	return { fast: vi.fn(async () => reply), smart: vi.fn(async () => reply) } as unknown as GlueClient;
}
function failingGlue(): GlueClient {
	return {
		fast: vi.fn(async () => {
			throw new Error("boom");
		}),
		smart: vi.fn(async () => {
			throw new Error("boom");
		}),
	} as unknown as GlueClient;
}

describe("extractJson", () => {
	it("parses clean JSON", () => {
		expect(extractJson('{"done": true}')).toEqual({ done: true });
	});

	it("extracts JSON embedded in prose", () => {
		const raw = 'Here you go:\n{"question": "?", "options": []}\nHope that works.';
		expect(extractJson(raw)).toEqual({ question: "?", options: [] });
	});

	it("returns null for unbalanced braces", () => {
		expect(extractJson("{ bogus")).toBeNull();
	});

	it("handles strings containing braces", () => {
		expect(extractJson('{"q": "use {curly} braces"}')).toEqual({ q: "use {curly} braces" });
	});

	it("returns null for input with no JSON at all", () => {
		expect(extractJson("plain prose, no json here")).toBeNull();
	});
});

describe("generateQuestion", () => {
	it("returns a normalized question with options", async () => {
		const glue = fakeGlue(
			JSON.stringify({
				question: "How should auth be handled?",
				options: [
					{ id: "opt1", label: "Email + password" },
					{ label: "Magic link" }, // missing id — auto-generated
				],
			}),
		);
		const result = await generateQuestion(glue, "Add auth", [], 0);
		expect(result.done).toBe(false);
		expect(result.question?.question).toBe("How should auth be handled?");
		expect(result.question?.options?.length).toBe(2);
		expect(result.question?.options?.[1].id).toBe("opt2");
	});

	it("respects done=true after MIN_QUESTIONS reached", async () => {
		const glue = fakeGlue('{"done": true}');
		const result = await generateQuestion(glue, "x", [{ question: "Q", answer: "A" }], 1);
		expect(result.done).toBe(true);
	});

	it("synthesizes a fallback when LLM tries to stop before MIN_QUESTIONS", async () => {
		const glue = fakeGlue('{"done": true}');
		const result = await generateQuestion(glue, "x", [], 0);
		expect(result.done).toBe(false);
		expect(result.question?.question).toMatch(/constraint|non-goal/i);
	});

	it("forces done=true after MAX_QUESTIONS", async () => {
		const glue = fakeGlue('{"question":"more?"}');
		const result = await generateQuestion(glue, "x", [], MAX_QUESTIONS);
		expect(result.done).toBe(true);
	});

	it("returns done with a reason on glue error", async () => {
		const glue = failingGlue();
		const result = await generateQuestion(glue, "x", [], 1);
		expect(result.done).toBe(true);
		expect(result.reason).toMatch(/glue error/);
	});

	it("returns done with a reason when LLM emits nothing parseable", async () => {
		const glue = fakeGlue("¯\\_(ツ)_/¯ no json here");
		const result = await generateQuestion(glue, "x", [], 1);
		expect(result.done).toBe(true);
	});
});

describe("generatePlan / revisePlan", () => {
	it("returns trimmed plan markdown from generatePlan", async () => {
		const glue = fakeGlue("\n# Plan\n\n## Goal\nDo a thing.\n\n## Steps\n1. Do it\n");
		await expect(generatePlan(glue, "x", [])).resolves.toBe("# Plan\n\n## Goal\nDo a thing.\n\n## Steps\n1. Do it");
	});

	it("returns trimmed plan from revisePlan", async () => {
		const glue = fakeGlue("\n# Revised plan\n\n## Goal\nUpdated.\n");
		await expect(revisePlan(glue, "old plan", "make it bigger")).resolves.toBe("# Revised plan\n\n## Goal\nUpdated.");
	});
});

describe("parseAnswer", () => {
	const q: PlanQuestion = {
		id: "q1",
		question: "Which?",
		options: [
			{ id: "a", label: "Email" },
			{ id: "b", label: "Magic link" },
			{ id: "c", label: "OAuth2" },
		],
	};

	it("maps a 1-based number to the option label", () => {
		expect(parseAnswer("2", q)).toBe("Magic link");
	});

	it("maps an exact label match (case-insensitive)", () => {
		expect(parseAnswer("oauth2", q)).toBe("OAuth2");
	});

	it("maps option-count+1 to the start-building escape", () => {
		expect(parseAnswer("4", q)).toBe(ANSWER_START_BUILDING);
	});

	it("falls back to the typed text for free-form answers", () => {
		expect(parseAnswer("session-based JWT please", q)).toBe("session-based JWT please");
	});

	it("returns the typed text when there are no options", () => {
		const free: PlanQuestion = { id: "q2", question: "?" };
		expect(parseAnswer("anything goes", free)).toBe("anything goes");
	});
});

describe("buildAgentPrompt", () => {
	it("includes original prompt, Q&A, plan, and the canonical header/footer", () => {
		const out = buildAgentPrompt("Add auth", "# Plan\n## Steps\n1. Stuff", [{ question: "Which?", answer: "OAuth" }]);
		expect(out).toContain("Build this project. Follow the approved plan exactly.");
		expect(out).toContain("Original request: Add auth");
		expect(out).toContain("Q: Which?");
		expect(out).toContain("A: OAuth");
		expect(out).toContain("# Plan");
		expect(out).toContain("Implement every listed item. Keep going until all files are written.");
	});
});
