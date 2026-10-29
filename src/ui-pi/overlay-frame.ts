import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { ansi } from "./theme.js";

/** Width a framed overlay's body gets: two border columns plus one space of padding each side. */
export const frameInnerWidth = (width: number): number => Math.max(1, width - 4);

/** Draw a rounded border around overlay lines rendered at `frameInnerWidth(width)`. */
export function frame(lines: string[], width: number, color: (text: string) => string = ansi.cyan): string[] {
	const inner = frameInnerWidth(width);
	const left = `${color("│")} `;
	const right = ` ${color("│")}`;
	const body = lines.map((line) => {
		const fitted = truncateToWidth(line, inner);
		return `${left}${fitted}\x1b[0m${" ".repeat(Math.max(0, inner - visibleWidth(fitted)))}${right}`;
	});
	const edge = "─".repeat(inner + 2);
	return [color(`╭${edge}╮`), ...body, color(`╰${edge}╯`)];
}
