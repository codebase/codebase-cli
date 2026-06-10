import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { atomicWrite, isLikelyBinary, stripBOM } from "./file-ops.js";

describe("stripBOM", () => {
	it("decodes plain UTF-8 with no BOM", () => {
		const out = stripBOM(Buffer.from("hello", "utf8"));
		expect(out).toEqual({ content: "hello", hasBOM: false, encoding: "utf8" });
	});

	it("strips a UTF-8 BOM", () => {
		const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hi", "utf8")]);
		const out = stripBOM(buf);
		expect(out.content).toBe("hi");
		expect(out.hasBOM).toBe(true);
		expect(out.encoding).toBe("utf8");
	});

	it("decodes UTF-16LE with BOM", () => {
		const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("héllo", "utf16le")]);
		const out = stripBOM(buf);
		expect(out.content).toBe("héllo");
		expect(out.hasBOM).toBe(true);
		expect(out.encoding).toBe("utf16le");
	});

	it("decodes UTF-16BE with BOM (byte-swapped)", () => {
		const le = Buffer.from("wörld", "utf16le");
		const be = Buffer.from(le);
		be.swap16();
		const buf = Buffer.concat([Buffer.from([0xfe, 0xff]), be]);
		const out = stripBOM(buf);
		expect(out.content).toBe("wörld");
		expect(out.hasBOM).toBe(true);
		expect(out.encoding).toBe("utf16be");
	});
});

describe("isLikelyBinary", () => {
	it("flags a buffer with embedded null bytes", () => {
		expect(isLikelyBinary(Buffer.from([0x68, 0x00, 0x69]))).toBe(true);
	});

	it("does NOT flag a UTF-16LE text file as binary despite its null bytes", () => {
		const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("plain ascii text", "utf16le")]);
		expect(isLikelyBinary(buf)).toBe(false);
	});

	it("does NOT flag a UTF-16BE text file as binary", () => {
		const le = Buffer.from("plain ascii text", "utf16le");
		const be = Buffer.from(le);
		be.swap16();
		const buf = Buffer.concat([Buffer.from([0xfe, 0xff]), be]);
		expect(isLikelyBinary(buf)).toBe(false);
	});

	it("treats plain UTF-8 as text", () => {
		expect(isLikelyBinary(Buffer.from("just text", "utf8"))).toBe(false);
	});
});

describe("atomicWrite encoding round-trip", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fileops-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("round-trips a UTF-16LE file: read → edit → write preserves encoding + BOM", () => {
		const path = join(dir, "win.txt");
		// Author a UTF-16LE file with BOM, like a Windows editor would.
		const original = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("line one\nline two", "utf16le")]);
		require("node:fs").writeFileSync(path, original);

		const decoded = stripBOM(readFileSync(path));
		expect(decoded.encoding).toBe("utf16le");

		// Simulate an edit + write-back preserving the detected encoding.
		const edited = decoded.content.replace("two", "TWO");
		atomicWrite(path, edited, { hasBOM: decoded.hasBOM, encoding: decoded.encoding });

		// Re-read raw: BOM intact, still UTF-16LE, content updated.
		const reread = readFileSync(path);
		expect(reread[0]).toBe(0xff);
		expect(reread[1]).toBe(0xfe);
		const redecoded = stripBOM(reread);
		expect(redecoded.encoding).toBe("utf16le");
		expect(redecoded.content).toBe("line one\nline TWO");
	});

	it("writes plain UTF-8 by default", () => {
		const path = join(dir, "u8.txt");
		atomicWrite(path, "hello world", {});
		const buf = readFileSync(path);
		expect(buf[0]).not.toBe(0xff);
		expect(buf.toString("utf8")).toBe("hello world");
	});
});
