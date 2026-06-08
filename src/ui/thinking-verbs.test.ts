import { describe, expect, it } from "vitest";
import { pickNextVerb, THINKING_VERBS } from "./thinking-verbs.js";

describe("THINKING_VERBS", () => {
	it("has at least two entries so pickNextVerb can find a non-current pick", () => {
		expect(THINKING_VERBS.length).toBeGreaterThan(1);
	});

	it("starts with 'Thinking' — both render paths reset to this at busy-state entry", () => {
		expect(THINKING_VERBS[0]).toBe("Thinking");
	});
});

describe("pickNextVerb", () => {
	it("never returns the same verb twice in a row", () => {
		for (const current of THINKING_VERBS) {
			for (let trial = 0; trial < 20; trial++) {
				const next = pickNextVerb(current);
				expect(next).not.toBe(current);
				expect(THINKING_VERBS).toContain(next);
			}
		}
	});
});
