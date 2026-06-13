import { describe, expect, it } from "vitest";
import { splitMarkdownSegments } from "./markdown-split.js";

describe("splitMarkdownSegments", () => {
	it("returns a single prose segment when there's no code", () => {
		expect(splitMarkdownSegments("just some text\nover two lines")).toEqual([
			{ type: "prose", text: "just some text\nover two lines" },
		]);
	});

	it("splits prose / code / prose with the language tag", () => {
		const md = "Run this:\n```bash\nnpm run build\nnode dist/cli.js\n```\nThen check the output.";
		expect(splitMarkdownSegments(md)).toEqual([
			{ type: "prose", text: "Run this:" },
			{ type: "code", lang: "bash", text: "npm run build\nnode dist/cli.js" },
			{ type: "prose", text: "Then check the output." },
		]);
	});

	it("handles a code block with no language tag", () => {
		const segs = splitMarkdownSegments("```\nplain code\n```");
		expect(segs).toEqual([{ type: "code", lang: "", text: "plain code" }]);
	});

	it("handles multiple code blocks", () => {
		const md = "```js\na\n```\nmiddle\n```py\nb\n```";
		const segs = splitMarkdownSegments(md);
		expect(segs.map((s) => s.type)).toEqual(["code", "prose", "code"]);
		expect(segs[0]).toMatchObject({ lang: "js", text: "a" });
		expect(segs[2]).toMatchObject({ lang: "py", text: "b" });
	});

	it("supports ~~~ fences", () => {
		expect(splitMarkdownSegments("~~~\ncode\n~~~")).toEqual([{ type: "code", lang: "", text: "code" }]);
	});

	it("treats an unterminated fence as prose", () => {
		const segs = splitMarkdownSegments("```bash\nnpm run build\n(no close)");
		expect(segs).toHaveLength(1);
		expect(segs[0].type).toBe("prose");
	});

	it("drops whitespace-only prose gaps", () => {
		const segs = splitMarkdownSegments("```\nx\n```\n\n```\ny\n```");
		expect(segs.map((s) => s.type)).toEqual(["code", "code"]);
	});

	it("does not treat inline backticks as a fence", () => {
		const segs = splitMarkdownSegments("use the `foo` function please");
		expect(segs).toEqual([{ type: "prose", text: "use the `foo` function please" }]);
	});
});
