import { describe, expect, it } from "vitest";
import { highlight, rulesFor } from "./highlight.js";

describe("highlight", () => {
	it("returns plain text for unknown language", () => {
		const tokens = highlight("foo bar", "klingon");
		expect(tokens).toEqual([{ kind: "text", text: "foo bar" }]);
	});

	it("tokenizes typescript", () => {
		const tokens = highlight('const x = "hi";', "ts");
		const keyword = tokens.find((t) => t.text === "const");
		const string = tokens.find((t) => t.text === '"hi"');
		const number = tokens.find((t) => t.kind === "number");
		expect(keyword?.kind).toBe("keyword");
		expect(string?.kind).toBe("string");
		expect(number).toBeUndefined();
	});

	it("recognizes typescript comments", () => {
		const tokens = highlight("// hello\nconst x = 1;", "ts");
		expect(tokens[0]).toEqual({ kind: "comment", text: "// hello" });
	});

	it("tokenizes python keyword and string", () => {
		const tokens = highlight('def foo():\n    return "bar"', "python");
		expect(tokens.find((t) => t.text === "def")?.kind).toBe("keyword");
		expect(tokens.find((t) => t.text === '"bar"')?.kind).toBe("string");
	});

	it("tokenizes go", () => {
		const tokens = highlight("func main() {}", "go");
		expect(tokens.find((t) => t.text === "func")?.kind).toBe("keyword");
		expect(tokens.find((t) => t.text === "main")?.kind).toBe("function");
	});

	it("tokenizes shell with $vars", () => {
		const tokens = highlight("echo $HOME", "bash");
		expect(tokens.find((t) => t.text === "$HOME")?.kind).toBe("property");
	});

	it("tokenizes json properties separately from string values", () => {
		const tokens = highlight('{"a":"b"}', "json");
		expect(tokens.find((t) => t.text === '"a"')?.kind).toBe("property");
		expect(tokens.find((t) => t.text === '"b"')?.kind).toBe("string");
	});

	it("preserves whitespace in output", () => {
		const tokens = highlight("const  x", "ts");
		const text = tokens.map((t) => t.text).join("");
		expect(text).toBe("const  x");
	});

	it("falls back for null language", () => {
		expect(rulesFor(undefined)).toBeNull();
		expect(rulesFor("")).toBeNull();
	});

	it("aliases tsx/jsx to typescript rules", () => {
		expect(rulesFor("tsx")).toBe(rulesFor("ts"));
		expect(rulesFor("jsx")).toBe(rulesFor("js"));
	});
});
