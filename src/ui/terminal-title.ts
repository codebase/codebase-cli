/**
 * Set the terminal window/tab title via two independent channels:
 *
 * 1. OSC 0 escape — read by xterm, iTerm2, Ghostty, kitty, alacritty,
 *    gnome-terminal, konsole, and tmux/screen forward it through. This
 *    is the standard.
 *
 * 2. process.title — VS Code and Cursor's integrated terminals show
 *    "node" by default because their tab-title template defaults to
 *    `${process}`, which reads the OS process name rather than the OSC
 *    sequence. Setting process.title changes what the OS reports, so
 *    VS Code's default template picks up our chosen name.
 *
 * Both writes are no-ops on non-TTY stdouts (piped output, CI logs)
 * so we don't pollute captured output with stray escape bytes.
 *
 * We intentionally don't try to "restore" the prior title on exit:
 * there's no portable way to read the current title, and the parent
 * shell's prompt hook resets it within milliseconds anyway.
 */
export function setTerminalTitle(title: string): void {
	if (!process.stdout.isTTY) return;
	process.stdout.write(`\x1b]0;${title}\x07`);
	try {
		process.title = title;
	} catch {
		// On some platforms / sandboxed environments process.title is
		// read-only or restricted. The OSC write is the main path; this
		// is just additional coverage for editor terminals.
	}
}
