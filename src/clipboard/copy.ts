import { spawn } from "node:child_process";

export type ClipboardMethod = "osc52" | "pbcopy" | "wl-copy" | "xclip" | "clip.exe";

export interface CopyOptions {
	/** Override auto-detection. Mostly for tests. */
	method?: ClipboardMethod;
	/** Where to write OSC 52 sequences. Defaults to process.stdout. */
	stdout?: NodeJS.WritableStream;
	/** True if running inside tmux. Defaults to !!process.env.TMUX. */
	insideTmux?: boolean;
	/** Write side-effect cap. OSC 52 sequences over ~75 KB get rejected by some terminals. */
	maxBytes?: number;
}

export interface CopyResult {
	method: ClipboardMethod;
	bytes: number;
	truncated: boolean;
}

const DEFAULT_MAX_BYTES = 75_000;

/**
 * Push text to the system clipboard via the most reliable available
 * channel. Strategy:
 *   1. SSH session → OSC 52 (only path that crosses the network)
 *   2. macOS → pbcopy (rock solid)
 *   3. WSL → clip.exe (writes to Windows clipboard from WSL)
 *   4. Linux Wayland with wl-copy installed → wl-copy
 *   5. Linux X11 with xclip installed → xclip
 *   6. fallback → OSC 52 (works in most modern terminals)
 *
 * Caller can override via `options.method` for tests or to force a
 * specific path. Always returns the actual method used and the byte
 * count written; throws if the method's underlying transport fails.
 */
export async function copyToClipboard(text: string, options: CopyOptions = {}): Promise<CopyResult> {
	const max = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const truncated = Buffer.byteLength(text, "utf8") > max;
	const payload = truncated ? text.slice(0, max) : text;
	const method = options.method ?? (await detectClipboardMethod());

	switch (method) {
		case "osc52":
			writeOsc52(payload, options.stdout ?? process.stdout, options.insideTmux ?? !!process.env.TMUX);
			break;
		case "pbcopy":
			await spawnCopy("pbcopy", [], payload);
			break;
		case "clip.exe":
			await spawnCopy("clip.exe", [], payload);
			break;
		case "wl-copy":
			await spawnCopy("wl-copy", [], payload);
			break;
		case "xclip":
			await spawnCopy("xclip", ["-selection", "clipboard"], payload);
			break;
	}

	return { method, bytes: Buffer.byteLength(payload, "utf8"), truncated };
}

export async function detectClipboardMethod(env: NodeJS.ProcessEnv = process.env): Promise<ClipboardMethod> {
	if (env.SSH_CONNECTION || env.SSH_CLIENT) return "osc52";
	if (process.platform === "darwin") return "pbcopy";
	if (await commandExists("clip.exe")) return "clip.exe";
	if (env.WAYLAND_DISPLAY && (await commandExists("wl-copy"))) return "wl-copy";
	if (await commandExists("xclip")) return "xclip";
	return "osc52";
}

/**
 * Emit an OSC 52 escape sequence carrying the base64-encoded payload.
 * Inside tmux we wrap it in tmux's DCS pass-through so the embedding
 * terminal still sees the escape.
 */
export function writeOsc52(text: string, stdout: NodeJS.WritableStream, insideTmux: boolean): void {
	const b64 = Buffer.from(text, "utf8").toString("base64");
	if (insideTmux) {
		stdout.write(`\x1bPtmux;\x1b\x1b]52;c;${b64}\x07\x1b\\`);
	} else {
		stdout.write(`\x1b]52;c;${b64}\x07`);
	}
}

function spawnCopy(cmd: string, args: string[], text: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
		child.on("error", reject);
		child.on("close", (code) => {
			if (code !== 0) reject(new Error(`${cmd} exited ${code}`));
			else resolve();
		});
		child.stdin?.end(text, "utf8");
	});
}

function commandExists(cmd: string): Promise<boolean> {
	return new Promise((resolve) => {
		const which = process.platform === "win32" ? "where" : "which";
		const child = spawn(which, [cmd], { stdio: "ignore" });
		child.on("error", () => resolve(false));
		child.on("close", (code) => resolve(code === 0));
	});
}

/**
 * Pull the most-recent code block out of a markdown body. Recognizes
 * triple-backtick fences with or without a language tag. Returns null
 * if no fenced block is found.
 */
export function extractLastCodeBlock(markdown: string): string | null {
	const fenceRe = /```[^\n]*\n([\s\S]*?)```/g;
	let match: RegExpExecArray | null;
	let last: string | null = null;
	while (true) {
		match = fenceRe.exec(markdown);
		if (!match) break;
		last = match[1];
	}
	return last !== null ? last.replace(/\n$/, "") : null;
}
