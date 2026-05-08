import { describe, expect, it } from "vitest";
import {
	backspace,
	deleteForward,
	initialInputState,
	insertChar,
	killToEnd,
	killToStart,
	killWordBack,
	killWordForward,
	moveEnd,
	moveLeft,
	moveRight,
	moveStart,
	setBuffer,
	undo,
	yank,
} from "./input-state.js";

describe("input-state basics", () => {
	it("starts empty with cursor at 0", () => {
		const s = initialInputState();
		expect(s.buffer).toBe("");
		expect(s.cursor).toBe(0);
		expect(s.killRing).toEqual([]);
	});

	it("insertChar appends and advances cursor", () => {
		let s = initialInputState();
		for (const ch of "hi") s = insertChar(s, ch);
		expect(s.buffer).toBe("hi");
		expect(s.cursor).toBe(2);
	});

	it("insertChar at cursor=middle inserts in place", () => {
		let s = setBuffer(initialInputState(), "hllo");
		s = { ...s, cursor: 1 };
		s = insertChar(s, "e");
		expect(s.buffer).toBe("hello");
		expect(s.cursor).toBe(2);
	});
});

describe("cursor movement", () => {
	it("moveLeft / moveRight clamp at boundaries", () => {
		let s = setBuffer(initialInputState(), "abc");
		s = moveStart(s);
		expect(s.cursor).toBe(0);
		s = moveLeft(s);
		expect(s.cursor).toBe(0); // clamped
		s = moveRight(s);
		expect(s.cursor).toBe(1);
		s = moveEnd(s);
		expect(s.cursor).toBe(3);
		s = moveRight(s);
		expect(s.cursor).toBe(3); // clamped
	});
});

describe("delete operations", () => {
	it("backspace removes char before cursor", () => {
		let s = setBuffer(initialInputState(), "abc");
		s = moveEnd(s);
		s = backspace(s);
		expect(s.buffer).toBe("ab");
		expect(s.cursor).toBe(2);
	});

	it("backspace at cursor=0 is a no-op", () => {
		const s = setBuffer(initialInputState(), "abc");
		const after = backspace(s);
		expect(after.buffer).toBe("abc");
	});

	it("deleteForward removes char at cursor", () => {
		let s = setBuffer(initialInputState(), "abc");
		s = moveStart(s);
		s = deleteForward(s);
		expect(s.buffer).toBe("bc");
		expect(s.cursor).toBe(0);
	});

	it("deleteForward at end is a no-op", () => {
		let s = setBuffer(initialInputState(), "abc");
		s = moveEnd(s);
		const after = deleteForward(s);
		expect(after.buffer).toBe("abc");
	});
});

describe("kill / yank ring", () => {
	it("killToEnd removes from cursor onward and pushes to ring", () => {
		let s = setBuffer(initialInputState(), "hello world");
		s = { ...s, cursor: 5 };
		s = killToEnd(s);
		expect(s.buffer).toBe("hello");
		expect(s.killRing).toEqual([" world"]);
	});

	it("killToStart removes from start to cursor and pushes to ring", () => {
		let s = setBuffer(initialInputState(), "hello world");
		s = { ...s, cursor: 6 };
		s = killToStart(s);
		expect(s.buffer).toBe("world");
		expect(s.cursor).toBe(0);
		expect(s.killRing).toEqual(["hello "]);
	});

	it("consecutive kills accumulate into one ring entry", () => {
		let s = setBuffer(initialInputState(), "alpha beta gamma");
		s = moveStart(s);
		s = killWordForward(s); // → "alpha"
		s = killWordForward(s); // → " beta" (concat to same entry, after)
		expect(s.killRing).toHaveLength(1);
		expect(s.killRing[0]).toBe("alpha beta");
	});

	it("a non-kill action breaks the chain so the next kill starts a fresh ring entry", () => {
		let s = setBuffer(initialInputState(), "alpha beta");
		s = moveStart(s);
		s = killWordForward(s); // ring = ["alpha"]
		s = moveRight(s); // breaks chain
		s = killWordForward(s); // ring = ["alpha", " beta"]
		expect(s.killRing).toHaveLength(2);
	});

	it("yank inserts the most-recent kill at cursor", () => {
		let s = setBuffer(initialInputState(), "hello world");
		s = moveEnd(s);
		s = killWordBack(s); // kills "world", buffer = "hello "
		s = moveStart(s);
		s = yank(s);
		expect(s.buffer).toBe("worldhello ");
		expect(s.cursor).toBe(5);
	});

	it("yank with empty ring is a no-op", () => {
		const s = setBuffer(initialInputState(), "abc");
		const after = yank(s);
		expect(after.buffer).toBe("abc");
	});

	it("Ctrl-W direction is 'before' so prior word prepends in chain mode", () => {
		let s = setBuffer(initialInputState(), "alpha beta");
		s = moveEnd(s);
		s = killWordBack(s); // kills "beta"
		s = killWordBack(s); // kills "alpha " (prepends)
		expect(s.killRing).toHaveLength(1);
		expect(s.killRing[0]).toBe("alpha beta");
	});
});

describe("word boundaries", () => {
	it("killWordBack walks past trailing non-word chars first", () => {
		let s = setBuffer(initialInputState(), "foo bar  ");
		s = moveEnd(s);
		s = killWordBack(s);
		expect(s.buffer).toBe("foo ");
	});

	it("killWordForward walks past leading non-word chars first", () => {
		let s = setBuffer(initialInputState(), "  foo bar");
		s = moveStart(s);
		s = killWordForward(s);
		expect(s.buffer).toBe(" bar");
	});
});

describe("undo", () => {
	it("undoes the most recent destructive action", () => {
		let s = setBuffer(initialInputState(), "hello");
		s = moveEnd(s);
		s = backspace(s);
		expect(s.buffer).toBe("hell");
		s = undo(s);
		expect(s.buffer).toBe("hello");
	});

	it("undoes a kill", () => {
		let s = setBuffer(initialInputState(), "hello world");
		s = { ...s, cursor: 5 };
		s = killToEnd(s);
		expect(s.buffer).toBe("hello");
		s = undo(s);
		expect(s.buffer).toBe("hello world");
	});

	it("undo with empty stack is a no-op", () => {
		const s = setBuffer(initialInputState(), "abc");
		const after = undo(s);
		expect(after).toMatchObject({ buffer: "abc" });
	});

	it("typing only snapshots at action-boundary transitions", () => {
		let s = initialInputState();
		// First insert pushes one snapshot (boundary transition init→type)
		s = insertChar(s, "h");
		expect(s.undoStack.length).toBe(1);
		// Subsequent inserts within the same type-run do NOT push more snapshots
		s = insertChar(s, "e");
		s = insertChar(s, "l");
		expect(s.undoStack.length).toBe(1);
		// A kill is a boundary; the next type pushes a fresh snapshot
		s = killWordBack(s);
		s = insertChar(s, "X");
		expect(s.undoStack.length).toBeGreaterThanOrEqual(2);
	});

	it("undo coalesces a typing run into one step", () => {
		let s = initialInputState();
		for (const ch of "hello") s = insertChar(s, ch);
		s = undo(s);
		// All five chars undone in one step.
		expect(s.buffer).toBe("");
	});
});
