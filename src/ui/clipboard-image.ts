import { spawn } from "node:child_process";

/**
 * Read an image off the system clipboard and return it as an
 * ImageContent block the agent can take as input. Terminals don't deliver
 * image bytes through paste (bracketed paste is text-only), so we shell
 * out to the platform's clipboard tool on demand — the same approach
 * Claude Code uses.
 *
 * Returns null when no tool is installed, the clipboard holds no image,
 * or the read fails — callers treat that as "nothing to attach."
 */

export interface ClipboardImage {
	type: "image";
	mimeType: string;
	/** Base64-encoded image bytes. */
	data: string;
}

export interface ImageCommand {
	cmd: string;
	args: string[];
	mimeType: string;
}

/**
 * Pick the clipboard-image read command for this platform, or null when
 * we don't know one. Pure + testable; the caller checks the tool exists.
 */
export function detectImageCommand(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): ImageCommand | null {
	if (platform === "darwin") {
		// pngpaste streams the clipboard image as PNG to stdout with `-`.
		return { cmd: "pngpaste", args: ["-"], mimeType: "image/png" };
	}
	if (platform === "linux") {
		if (env.WAYLAND_DISPLAY) {
			return { cmd: "wl-paste", args: ["--type", "image/png", "--no-newline"], mimeType: "image/png" };
		}
		return { cmd: "xclip", args: ["-selection", "clipboard", "-t", "image/png", "-o"], mimeType: "image/png" };
	}
	if (platform === "win32") {
		// PowerShell pulls the clipboard image and writes PNG bytes to stdout.
		const ps =
			"$i=Get-Clipboard -Format Image; if($i){$ms=New-Object IO.MemoryStream; $i.Save($ms,[Drawing.Imaging.ImageFormat]::Png); [Console]::OpenStandardOutput().Write($ms.ToArray(),0,$ms.Length)}";
		return { cmd: "powershell", args: ["-NoProfile", "-Command", ps], mimeType: "image/png" };
	}
	return null;
}

export interface ReadClipboardDeps {
	command?: ImageCommand | null;
	/** Inject a spawn for tests. */
	run?: (cmd: string, args: string[]) => Promise<Buffer | null>;
}

export async function readClipboardImage(deps: ReadClipboardDeps = {}): Promise<ClipboardImage | null> {
	const command = deps.command !== undefined ? deps.command : detectImageCommand();
	if (!command) return null;
	const run = deps.run ?? runCapture;
	const bytes = await run(command.cmd, command.args);
	if (!bytes || bytes.length === 0) return null;
	return { type: "image", mimeType: command.mimeType, data: bytes.toString("base64") };
}

/** Spawn a command and capture its stdout as a Buffer; null on any failure. */
function runCapture(cmd: string, args: string[]): Promise<Buffer | null> {
	return new Promise((resolve) => {
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
		} catch {
			resolve(null);
			return;
		}
		const chunks: Buffer[] = [];
		child.stdout?.on("data", (c: Buffer) => chunks.push(c));
		child.on("error", () => resolve(null)); // tool not installed
		child.on("close", (code) => resolve(code === 0 && chunks.length > 0 ? Buffer.concat(chunks) : null));
	});
}
