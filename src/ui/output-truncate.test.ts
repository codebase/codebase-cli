import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_TOOL_OUTPUT_LINES, TOOL_OUTPUT_LIMITS, truncateOutput } from "./output-truncate.js";

function makeLines(n: number): string {
	const out: string[] = [];
	for (let i = 1; i <= n; i++) out.push(`line ${i}`);
	return out.join("\n");
}

describe("truncateOutput", () => {
	it("returns full text when within the default cap", () => {
		const text = makeLines(DEFAULT_MAX_TOOL_OUTPUT_LINES);
		const view = truncateOutput(text, undefined, false);
		expect(view.truncated).toBe(false);
	});

	it("splits into head + tail when beyond the cap", () => {
		const text = makeLines(40);
		const view = truncateOutput(text, undefined, false);
		expect(view.truncated).toBe(true);
		if (!view.truncated) return;
		expect(view.head.split("\n").length).toBeGreaterThan(0);
		expect(view.tail.split("\n").length).toBeGreaterThan(0);
		expect(view.hidden).toBeGreaterThan(0);
		// All slots should account for the total exactly.
		expect(view.head.split("\n").length + view.tail.split("\n").length + view.hidden).toBe(40);
	});

	it("uses a tighter cap for grep", () => {
		const text = makeLines(8);
		const view = truncateOutput(text, "grep", false);
		expect(view.truncated).toBe(true);
		if (!view.truncated) return;
		// Cap is 6 → head + tail < 8 lines.
		expect(view.head.split("\n").length + view.tail.split("\n").length).toBeLessThan(8);
	});

	it("never truncates errors", () => {
		const text = makeLines(200);
		const view = truncateOutput(text, "shell", true);
		expect(view.truncated).toBe(false);
		if (view.truncated) return;
		expect(view.full).toBe(text);
	});

	it("recognises the curated per-tool limits", () => {
		expect(TOOL_OUTPUT_LIMITS.grep).toBe(6);
		expect(TOOL_OUTPUT_LIMITS.find).toBe(8);
		expect(TOOL_OUTPUT_LIMITS.list_files).toBe(10);
	});
});
