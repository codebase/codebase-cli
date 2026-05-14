import { exec } from "node:child_process";

/**
 * Heuristic: is this process running somewhere that obviously can't
 * launch a GUI browser? We bail out of the auto-open attempt instead
 * of letting xdg-open ENOENT or `open` hang on a headless macOS box.
 */
export function isHeadlessSession(): boolean {
	const env = process.env;
	if (env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT) return true;
	if (process.platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) return true;
	return false;
}

/** Best-effort browser open. Falls back to printing the URL on platforms we can't detect. */
export async function openBrowser(url: string): Promise<void> {
	const command = browserOpenCommand(url);
	if (!command) {
		throw new Error(`unsupported platform ${process.platform}`);
	}
	await new Promise<void>((resolve, reject) => {
		exec(command, (err) => (err ? reject(err) : resolve()));
	});
}

function browserOpenCommand(url: string): string | null {
	const escaped = url.replace(/"/g, '\\"');
	if (process.platform === "darwin") return `open "${escaped}"`;
	if (process.platform === "win32") return `start "" "${escaped}"`;
	if (process.platform === "linux") return `xdg-open "${escaped}"`;
	return null;
}
