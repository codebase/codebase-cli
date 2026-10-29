import type { Component } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { ScrollViewport } from "./scroll-viewport.js";

class Lines implements Component {
	renders = 0;
	constructor(private readonly lines: string[]) {}
	render(): string[] {
		this.renders++;
		return this.lines;
	}
	invalidate(): void {}
}

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const msgs = (n: number) => Array.from({ length: n }, (_, i) => new Lines([`line ${i}`]));
const footer = [new Lines(["status", "> input"])];

describe("ScrollViewport", () => {
	it("pins the footer under a blank row and fills exactly the screen height", () => {
		const out = new ScrollViewport().render(40, 7, msgs(2), footer);
		expect(out).toEqual(["line 0", "line 1", "", "", "", "status", "> input"]);
	});

	it("only renders the body components visible while following", () => {
		const body = msgs(100);
		const out = new ScrollViewport().render(40, 7, body, footer);
		expect(out.slice(0, 4)).toEqual(["line 96", "line 97", "line 98", "line 99"]);
		expect(body[0].renders).toBe(0);
		expect(body.filter((b) => b.renders > 0).length).toBeLessThanOrEqual(6);
	});

	it("scrolls up, stays anchored as content arrives, and resumes following at the bottom", () => {
		const vp = new ScrollViewport();
		const body = msgs(20);
		vp.scroll(5);
		let out = vp.render(40, 7, body, footer).map(strip);
		expect(out.slice(0, 3)).toEqual(["line 11", "line 12", "line 13"]);
		expect(out[3]).toContain("Jump to bottom (ctrl+End) ↓");

		body.push(...msgs(3));
		out = vp.render(40, 7, body, footer).map(strip);
		expect(out[0]).toBe("line 11");

		vp.scroll(-100);
		out = vp.render(40, 7, body, footer);
		expect(vp.following).toBe(true);
		expect(out[3]).toBe("line 2");
	});

	it("maps wheel and page keys, swallowing every mouse report", () => {
		const vp = new ScrollViewport();
		expect(vp.handleInput("\x1b[<64;10;5M", true)).toBe(true);
		expect(vp.following).toBe(false);
		expect(vp.handleInput("\x1b[<0;10;5M", false)).toBe(true);
		expect(vp.handleInput("\x1b[5~", false)).toBe(false);
		expect(vp.handleInput("\x1b[6~", true)).toBe(true);
		expect(vp.handleInput("a", true)).toBe(false);
		expect(vp.handleInput("\x1b[1;5F", true)).toBe(true);
		expect(vp.following).toBe(true);
	});
});

describe("ScrollViewport tabs", () => {
	it("expands tabs to the width pi-tui measured so rows never wrap", () => {
		const out = new ScrollViewport().render(40, 4, [new Lines(["\tindented"])], footer);
		expect(out[0]).toBe("   indented");
	});
});

describe("ScrollViewport selection", () => {
	const drag = (vp: ScrollViewport) => {
		vp.handleInput("\x1b[<0;1;1M", true);
		vp.handleInput("\x1b[<32;6;2M", true);
		vp.handleInput("\x1b[<0;6;2m", true);
	};

	it("keeps a drag selection without copying until Ctrl+C", () => {
		const copied: string[] = [];
		const vp = new ScrollViewport({ onCopy: (t) => copied.push(t) });
		const body = msgs(3);
		vp.render(40, 7, body, footer);
		drag(vp);
		expect(copied).toEqual([]);

		expect(vp.handleInput("\x03", true)).toBe(true);
		expect(copied).toEqual(["line 0\nline 1"]);
		expect(strip(vp.render(40, 7, body, footer)[3])).toContain("Copied 13 characters");
	});

	it("leaves Ctrl+C to the app when nothing is selected", () => {
		const vp = new ScrollViewport();
		vp.render(40, 7, msgs(3), footer);
		expect(vp.handleInput("\x03", true)).toBe(false);
	});

	it("does not start a selection in the pinned footer", () => {
		const copied: string[] = [];
		const vp = new ScrollViewport({ onCopy: (t) => copied.push(t) });
		vp.render(40, 7, msgs(3), footer);
		vp.handleInput("\x1b[<0;1;7M", true);
		vp.handleInput("\x1b[<32;6;7M", true);
		vp.handleInput("\x1b[<0;6;7m", true);
		vp.handleInput("\x03", true);
		expect(copied).toEqual([]);
	});

	it("jumps to the bottom when the badge is clicked", () => {
		const vp = new ScrollViewport();
		const body = msgs(20);
		vp.scroll(5);
		const row = vp.render(40, 7, body, footer)[3];
		const col = strip(row).indexOf("Jump") + 1;
		vp.handleInput(`\x1b[<0;${col};4M`, true);
		expect(vp.following).toBe(true);
	});
});

describe("ScrollViewport footer gap", () => {
	it("keeps exactly one blank row above the footer even when messages end with one", () => {
		const body = Array.from({ length: 10 }, (_, i) => new Lines([`msg ${i}`, ""]));
		const out = new ScrollViewport().render(40, 7, body, footer);
		expect(out).toEqual(["msg 7", "", "msg 8", "", "msg 9", "", "status", "> input"].slice(-7));
	});
});
