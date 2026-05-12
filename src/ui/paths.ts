import { isAbsolute, sep as pathSep, relative as relativePath, resolve as resolveAbsolute } from "node:path";

/**
 * Show a path relative to the working directory when it's inside (so
 * "src/ui/Message.tsx" instead of "/home/half/.../src/ui/Message.tsx"),
 * but keep it absolute when it points outside the project — that's
 * useful information the user should see at full fidelity. Empty
 * strings pass through unchanged. The returned string is wrapped in an
 * OSC 8 hyperlink so supporting terminals make it clickable.
 */
export function displayPath(p: string): string {
	if (!p) return p;
	const visible = makeRelative(p);
	return hyperlinkPath(visible, p);
}

export function makeRelative(p: string): string {
	if (!p.startsWith(pathSep)) return p; // already relative
	const cwd = process.cwd();
	const rel = relativePath(cwd, p);
	if (!rel || rel.startsWith("..")) return p; // outside cwd — keep absolute
	return rel;
}

/**
 * Wrap a visible path in an OSC 8 hyperlink so terminals that support
 * it (Ghostty, iTerm2, Kitty, recent gnome-terminal) make file paths
 * clickable — click opens the file in $EDITOR / the OS default. The
 * escape is zero-width and well-handled by wrap-ansi for width calc.
 * Terminals that don't recognise OSC 8 silently strip it, so the
 * fallback is just "non-clickable plain text" — no visible breakage.
 * Opt-out: NO_HYPERLINK=1.
 */
export function hyperlinkPath(visible: string, rawPath: string): string {
	if (process.env.NO_HYPERLINK === "1") return visible;
	const absolute = isAbsolute(rawPath) ? rawPath : resolveAbsolute(process.cwd(), rawPath);
	const url = `file://${absolute.split(pathSep).map(encodeURIComponent).join("/")}`;
	return `\x1b]8;;${url}\x1b\\${visible}\x1b]8;;\x1b\\`;
}
