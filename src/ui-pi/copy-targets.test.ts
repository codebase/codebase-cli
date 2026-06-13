import { describe, expect, it } from "vitest";
import {
	CopyRegistry,
	decodeSentinel,
	encodeSentinel,
	hitTest,
	scanAndStrip,
	viewportRowToLogical,
} from "./copy-targets.js";

describe("sentinel encode/decode", () => {
	it("round-trips an id", () => {
		expect(decodeSentinel(`${encodeSentinel(7)}hello`)).toBe(7);
		expect(decodeSentinel(`${encodeSentinel(123)} code`)).toBe(123);
	});

	it("returns null for a line without a sentinel", () => {
		expect(decodeSentinel("plain text")).toBeNull();
	});

	it("the sentinel adds no visible characters", () => {
		const s = encodeSentinel(42);
		// Every code point is in the Unicode Tags block (Default_Ignorable).
		for (const ch of s) {
			const cp = ch.codePointAt(0) as number;
			expect(cp).toBeGreaterThanOrEqual(0xe0000);
			expect(cp).toBeLessThanOrEqual(0xe007f);
		}
	});
});

describe("scanAndStrip", () => {
	it("records line→id and removes sentinels from output", () => {
		const lines = ["prose", `${encodeSentinel(1)}┌─ bash ─┐`, `${encodeSentinel(1)}│ npm run build │`, "more prose"];
		const { clean, lineToId } = scanAndStrip(lines);
		expect(lineToId.get(1)).toBe(1);
		expect(lineToId.get(2)).toBe(1);
		expect(lineToId.has(0)).toBe(false);
		expect(lineToId.has(3)).toBe(false);
		// No tag characters survive in the cleaned output.
		for (const line of clean) {
			for (const ch of line) expect(ch.codePointAt(0) as number).toBeLessThan(0xe0000);
		}
		expect(clean[1]).toBe("┌─ bash ─┐");
	});

	it("distinguishes adjacent boxes", () => {
		const lines = [`${encodeSentinel(1)}box one`, `${encodeSentinel(2)}box two`];
		const { lineToId } = scanAndStrip(lines);
		expect(lineToId.get(0)).toBe(1);
		expect(lineToId.get(1)).toBe(2);
	});
});

describe("viewportRowToLogical", () => {
	it("bottom-pins when content overflows the viewport", () => {
		// 100 lines, 24-row viewport: row 24 (bottom) = logical line 99.
		expect(viewportRowToLogical(24, 100, 24)).toBe(99);
		expect(viewportRowToLogical(1, 100, 24)).toBe(76);
	});

	it("top-anchors when content fits", () => {
		expect(viewportRowToLogical(1, 10, 24)).toBe(0);
		expect(viewportRowToLogical(5, 10, 24)).toBe(4);
	});
});

describe("hitTest", () => {
	it("resolves a click row to the box that owns that logical line", () => {
		// box id 9 lives on logical lines 96-98 of a 100-line column, 24-row screen.
		const lineToId = new Map([
			[96, 9],
			[97, 9],
			[98, 9],
		]);
		// logical 97 → viewport row 97 - (100-24) = 21.
		expect(hitTest(lineToId, 21, 100, 24)).toBe(9);
		// A row mapping to a line nobody owns → null.
		expect(hitTest(lineToId, 1, 100, 24)).toBeNull();
	});
});

describe("CopyRegistry", () => {
	it("hands out a stable id per dedupe key and stores text", () => {
		const reg = new CopyRegistry();
		const a = reg.idFor("msg-1:block-0");
		const b = reg.idFor("msg-1:block-1");
		expect(a).not.toBe(b);
		expect(reg.idFor("msg-1:block-0")).toBe(a); // stable across re-render
		reg.set(a, "npm run build");
		expect(reg.get(a)).toBe("npm run build");
	});
});
