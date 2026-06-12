import { describe, expect, it } from "vitest";
import { displayLine, filterHistory, searchCandidates } from "./history-search-core.js";

describe("searchCandidates", () => {
	it("returns newest first, deduplicated, blanks dropped", () => {
		const history = ["fix tests", "  ", "run build", "fix tests", "deploy"];
		expect(searchCandidates(history)).toEqual(["deploy", "fix tests", "run build"]);
	});

	it("handles empty history", () => {
		expect(searchCandidates([])).toEqual([]);
	});
});

describe("filterHistory", () => {
	const candidates = ["deploy to staging", "Fix the LOGIN test", "run build"];

	it("matches case-insensitively", () => {
		expect(filterHistory(candidates, "login")).toEqual(["Fix the LOGIN test"]);
	});

	it("empty query returns everything", () => {
		expect(filterHistory(candidates, "")).toEqual(candidates);
	});

	it("no match returns empty", () => {
		expect(filterHistory(candidates, "zzz")).toEqual([]);
	});
});

describe("displayLine", () => {
	it("flattens newlines", () => {
		expect(displayLine("a\nb")).toBe("a ⏎ b");
	});

	it("clips long entries", () => {
		const long = "x".repeat(150);
		expect(displayLine(long)).toHaveLength(100);
		expect(displayLine(long).endsWith("…")).toBe(true);
	});
});
