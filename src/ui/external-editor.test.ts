import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { editInExternalEditor, resolveEditor } from "./external-editor.js";

describe("resolveEditor", () => {
	it("prefers $VISUAL over $EDITOR", () => {
		expect(resolveEditor({ VISUAL: "code -w", EDITOR: "vi" })).toEqual({ cmd: "code", args: ["-w"] });
	});

	it("falls back to $EDITOR when $VISUAL is unset", () => {
		expect(resolveEditor({ EDITOR: "nano" })).toEqual({ cmd: "nano", args: [] });
	});

	it("splits multi-arg specs on whitespace", () => {
		expect(resolveEditor({ EDITOR: "emacsclient -nw -c" })).toEqual({
			cmd: "emacsclient",
			args: ["-nw", "-c"],
		});
	});

	it("ignores a whitespace-only spec", () => {
		const env = { VISUAL: "   ", EDITOR: "" };
		const { cmd } = resolveEditor(env);
		expect(cmd).toBe(process.platform === "win32" ? "notepad" : "vi");
	});
});

describe("editInExternalEditor", () => {
	it("writes the initial buffer, runs the editor, returns edited text", () => {
		let seenInitial: string | null = null;
		let suspended = false;
		let resumed = false;
		const result = editInExternalEditor("hello", {
			env: { EDITOR: "fake" },
			suspend: () => {
				suspended = true;
			},
			resume: () => {
				resumed = true;
			},
			run: (_cmd, args) => {
				const file = args[args.length - 1];
				seenInitial = readFileSync(file, "utf8");
				writeFileSync(file, "edited body\n", "utf8");
				return true;
			},
		});
		expect(seenInitial).toBe("hello");
		expect(result).toBe("edited body");
		expect(suspended).toBe(true);
		expect(resumed).toBe(true);
	});

	it("returns null when the editor exits non-zero", () => {
		const result = editInExternalEditor("x", {
			env: { EDITOR: "fake" },
			suspend: () => {},
			resume: () => {},
			run: () => false,
		});
		expect(result).toBeNull();
	});

	it("resumes the TUI even if the editor throws", () => {
		let resumed = false;
		const result = editInExternalEditor("x", {
			env: { EDITOR: "fake" },
			suspend: () => {},
			resume: () => {
				resumed = true;
			},
			run: () => {
				throw new Error("boom");
			},
		});
		expect(result).toBeNull();
		expect(resumed).toBe(true);
	});

	it("trims only a single trailing newline", () => {
		const result = editInExternalEditor("x", {
			env: { EDITOR: "fake" },
			suspend: () => {},
			resume: () => {},
			run: (_cmd, args) => {
				writeFileSync(args[args.length - 1], "line1\nline2\n", "utf8");
				return true;
			},
		});
		expect(result).toBe("line1\nline2");
	});
});
