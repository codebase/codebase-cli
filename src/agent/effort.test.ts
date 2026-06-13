import { describe, expect, it } from "vitest";
import { EFFORT_LEVELS, resolveEffort } from "./effort.js";

describe("resolveEffort", () => {
	it("accepts every valid level, case-insensitively", () => {
		for (const level of EFFORT_LEVELS) {
			expect(resolveEffort(level)).toBe(level);
			expect(resolveEffort(level.toUpperCase())).toBe(level);
		}
	});

	it("trims surrounding whitespace", () => {
		expect(resolveEffort("  high  ")).toBe("high");
	});

	it("returns undefined for unset or invalid input", () => {
		expect(resolveEffort(undefined)).toBeUndefined();
		expect(resolveEffort("")).toBeUndefined();
		expect(resolveEffort("turbo")).toBeUndefined();
	});
});
