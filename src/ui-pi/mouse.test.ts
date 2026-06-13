import { describe, expect, it } from "vitest";
import { isLeftClick, isMouseSequence, parseMouseEvent } from "./mouse.js";

describe("parseMouseEvent", () => {
	it("parses a left-button press", () => {
		expect(parseMouseEvent("\x1b[<0;20;5M")).toEqual({
			kind: "press",
			button: 0,
			col: 20,
			row: 5,
			shift: false,
			motion: false,
		});
	});

	it("parses a release", () => {
		const e = parseMouseEvent("\x1b[<0;20;5m");
		expect(e?.kind).toBe("release");
	});

	it("flags shift-modified clicks (the native-select escape hatch)", () => {
		const e = parseMouseEvent("\x1b[<4;1;1M");
		expect(e?.shift).toBe(true);
		expect(e?.button).toBe(0);
	});

	it("decodes wheel up/down", () => {
		expect(parseMouseEvent("\x1b[<64;1;1M")?.wheel).toBe("up");
		expect(parseMouseEvent("\x1b[<65;1;1M")?.wheel).toBe("down");
	});

	it("flags motion (drag) events", () => {
		expect(parseMouseEvent("\x1b[<32;1;1M")?.motion).toBe(true);
	});

	it("returns null for non-mouse data", () => {
		expect(parseMouseEvent("\x1b[A")).toBeNull();
		expect(parseMouseEvent("hello")).toBeNull();
	});
});

describe("isLeftClick", () => {
	it("accepts a plain left press", () => {
		expect(isLeftClick(parseMouseEvent("\x1b[<0;5;5M")!)).toBe(true);
	});

	it("rejects shift-clicks, drags, releases, and the wheel", () => {
		expect(isLeftClick(parseMouseEvent("\x1b[<4;5;5M")!)).toBe(false); // shift
		expect(isLeftClick(parseMouseEvent("\x1b[<32;5;5M")!)).toBe(false); // motion
		expect(isLeftClick(parseMouseEvent("\x1b[<0;5;5m")!)).toBe(false); // release
		expect(isLeftClick(parseMouseEvent("\x1b[<64;5;5M")!)).toBe(false); // wheel
		expect(isLeftClick(parseMouseEvent("\x1b[<2;5;5M")!)).toBe(false); // right button
	});
});

describe("isMouseSequence", () => {
	it("recognizes the SGR mouse prefix", () => {
		expect(isMouseSequence("\x1b[<0;1;1M")).toBe(true);
		expect(isMouseSequence("\x1b[A")).toBe(false);
		expect(isMouseSequence("x")).toBe(false);
	});
});
