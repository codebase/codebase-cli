/**
 * Set the terminal window/tab title via OSC 0. Honored by all modern
 * terminals (xterm, iTerm2, Ghostty, kitty) plus the integrated
 * terminals in VS Code, Cursor, JetBrains IDEs — so "node" tabs become
 * "codebase". TMUX/screen forward this through to the host emulator.
 *
 * No-op on non-TTY stdouts (piped output, CI logs) so we don't pollute
 * captured output with stray escape bytes.
 *
 * We intentionally don't try to "restore" the prior title on exit:
 * there's no portable way to read the current title, and on shell exit
 * the parent shell's PROMPT_COMMAND / precmd hook will set it back
 * within milliseconds. Setting it to empty would be worse than leaving
 * our title in place during the brief gap.
 */
export function setTerminalTitle(title: string): void {
	if (!process.stdout.isTTY) return;
	process.stdout.write(`\x1b]0;${title}\x07`);
}
