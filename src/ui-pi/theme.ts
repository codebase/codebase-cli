import type { MarkdownTheme, SelectListTheme } from "@mariozechner/pi-tui";

/**
 * ANSI escape helpers. Pi-tui doesn't ship a built-in theme — components
 * accept callbacks that wrap text in whatever style the host app prefers.
 * Keeping the palette here so phase-5 swap-the-theme is one file, not a
 * hunt across components.
 */
const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const wrap =
	(codes: string) =>
	(text: string): string =>
		`${ESC}${codes}m${text}${RESET}`;

export const ansi = {
	bold: wrap("1"),
	dim: wrap("2"),
	italic: wrap("3"),
	underline: wrap("4"),
	strikethrough: wrap("9"),
	red: wrap("31"),
	green: wrap("32"),
	yellow: wrap("33"),
	blue: wrap("34"),
	magenta: wrap("35"),
	cyan: wrap("36"),
	gray: wrap("90"),
	inverse: wrap("7"),
};

export const markdownTheme: MarkdownTheme = {
	heading: (text) => ansi.bold(ansi.cyan(text)),
	link: (text) => ansi.cyan(text),
	linkUrl: (text) => ansi.dim(ansi.underline(text)),
	code: (text) => ansi.cyan(text),
	codeBlock: (text) => text,
	codeBlockBorder: (text) => ansi.dim(text),
	quote: (text) => ansi.dim(text),
	quoteBorder: (text) => ansi.dim(text),
	hr: (text) => ansi.dim(text),
	listBullet: (text) => ansi.cyan(text),
	bold: (text) => ansi.bold(text),
	italic: (text) => ansi.italic(text),
	strikethrough: (text) => ansi.strikethrough(text),
	underline: (text) => ansi.underline(text),
};

export const selectListTheme: SelectListTheme = {
	selectedPrefix: (text) => ansi.cyan(text),
	selectedText: (text) => ansi.bold(ansi.cyan(text)),
	description: (text) => ansi.dim(text),
	scrollInfo: (text) => ansi.dim(text),
	noMatch: (text) => ansi.dim(text),
};

/** Common role-color mapping for the transcript header labels. */
export const roleColor = {
	user: ansi.yellow,
	assistant: ansi.cyan,
	toolResult: ansi.magenta,
	system: ansi.gray,
};
