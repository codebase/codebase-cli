import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { copyToClipboard, extractLastCodeBlock, writeOsc52 } from "./copy.js";

class CapturingStream extends Writable {
	chunks: Buffer[] = [];
	_write(chunk: Buffer, _enc: BufferEncoding, cb: () => void): void {
		this.chunks.push(chunk);
		cb();
	}
	get bytes(): Buffer {
		return Buffer.concat(this.chunks);
	}
	get text(): string {
		return this.bytes.toString("utf8");
	}
}

describe("writeOsc52", () => {
	it("emits the base OSC 52 sequence outside tmux", () => {
		const out = new CapturingStream();
		writeOsc52("hello", out, false);
		// \x1b]52;c;<b64>\x07
		expect(out.text).toBe(`\x1b]52;c;${Buffer.from("hello").toString("base64")}\x07`);
	});

	it("wraps in tmux DCS pass-through inside tmux", () => {
		const out = new CapturingStream();
		writeOsc52("hi", out, true);
		expect(out.text.startsWith("\x1bPtmux;")).toBe(true);
		expect(out.text.endsWith("\x1b\\")).toBe(true);
		expect(out.text).toContain(Buffer.from("hi").toString("base64"));
	});

	it("base64-encodes UTF-8 multi-byte content correctly", () => {
		const out = new CapturingStream();
		writeOsc52("über → 漢", out, false);
		const expected = Buffer.from("über → 漢", "utf8").toString("base64");
		expect(out.text).toContain(expected);
	});
});

describe("copyToClipboard", () => {
	it("uses the OSC 52 path when method=osc52 and writes to the supplied stream", async () => {
		const out = new CapturingStream();
		const result = await copyToClipboard("payload", { method: "osc52", stdout: out, insideTmux: false });
		expect(result.method).toBe("osc52");
		expect(result.bytes).toBe(7);
		expect(result.truncated).toBe(false);
		expect(out.text).toContain(Buffer.from("payload").toString("base64"));
	});

	it("truncates payloads beyond maxBytes and reports it", async () => {
		const out = new CapturingStream();
		const big = "a".repeat(1000);
		const result = await copyToClipboard(big, { method: "osc52", stdout: out, insideTmux: false, maxBytes: 100 });
		expect(result.bytes).toBe(100);
		expect(result.truncated).toBe(true);
	});

	it("reports SSH-detected method as osc52", async () => {
		const result = await copyToClipboard("x", { method: "osc52", stdout: new CapturingStream(), insideTmux: false });
		expect(result.method).toBe("osc52");
	});
});

describe("extractLastCodeBlock", () => {
	it("returns null when no fenced block is present", () => {
		expect(extractLastCodeBlock("just prose")).toBeNull();
	});

	it("extracts a single fenced block without language tag", () => {
		const md = "intro\n```\nfoo()\nbar()\n```\noutro";
		expect(extractLastCodeBlock(md)).toBe("foo()\nbar()");
	});

	it("extracts a fenced block with a language tag", () => {
		const md = "see this:\n```ts\nconst x = 1;\nconst y = 2;\n```\n";
		expect(extractLastCodeBlock(md)).toBe("const x = 1;\nconst y = 2;");
	});

	it("returns the LAST code block when multiple are present", () => {
		const md = "```\nfirst\n```\nmiddle\n```js\nsecond\n```\nend";
		expect(extractLastCodeBlock(md)).toBe("second");
	});

	it("strips a single trailing newline before the fence", () => {
		const md = "```\nbody\nmore\n```";
		expect(extractLastCodeBlock(md)).toBe("body\nmore");
	});

	it("handles back-to-back blocks", () => {
		const md = "```\nA\n```\n```\nB\n```";
		expect(extractLastCodeBlock(md)).toBe("B");
	});
});
