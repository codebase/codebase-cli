import { describe, expect, it } from "vitest";
import { detectImageCommand, readClipboardImage } from "./clipboard-image.js";

describe("detectImageCommand", () => {
	it("uses pngpaste on macOS", () => {
		expect(detectImageCommand("darwin", {})).toMatchObject({ cmd: "pngpaste", mimeType: "image/png" });
	});

	it("uses wl-paste on Wayland Linux", () => {
		expect(detectImageCommand("linux", { WAYLAND_DISPLAY: "wayland-0" })?.cmd).toBe("wl-paste");
	});

	it("uses xclip on X11 Linux", () => {
		expect(detectImageCommand("linux", {})?.cmd).toBe("xclip");
	});

	it("uses powershell on Windows", () => {
		expect(detectImageCommand("win32", {})?.cmd).toBe("powershell");
	});

	it("returns null on unknown platforms", () => {
		expect(detectImageCommand("aix" as NodeJS.Platform, {})).toBeNull();
	});
});

describe("readClipboardImage", () => {
	it("returns an ImageContent block when the tool yields bytes", async () => {
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic
		const img = await readClipboardImage({
			command: { cmd: "x", args: [], mimeType: "image/png" },
			run: async () => png,
		});
		expect(img).toEqual({ type: "image", mimeType: "image/png", data: png.toString("base64") });
	});

	it("returns null when the clipboard has no image (empty output)", async () => {
		const img = await readClipboardImage({
			command: { cmd: "x", args: [], mimeType: "image/png" },
			run: async () => null,
		});
		expect(img).toBeNull();
	});

	it("returns null when no tool is known for the platform", async () => {
		expect(await readClipboardImage({ command: null })).toBeNull();
	});
});
