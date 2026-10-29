import { Container, Input as PiInput, Text } from "@earendil-works/pi-tui";
import type { UserQuery } from "../user-queries/store.js";
import { frame, frameInnerWidth } from "./overlay-frame.js";
import { ansi } from "./theme.js";

/**
 * Inline overlay shown when a tool (or plan-mode flow) needs the user
 * to answer a free-form question. The question + optional options list
 * print above an Input the user types into. Enter submits, Esc cancels.
 */
export class UserQueryOverlay extends Container {
	private readonly input: PiInput;

	constructor(query: UserQuery, onAnswer: (answer: string) => void, onCancel: () => void) {
		super();
		this.addChild(new Text(`${ansi.cyan(ansi.bold("?"))} ${query.question}`, 0, 0));
		if (query.options && query.options.length > 0) {
			for (let i = 0; i < query.options.length; i++) {
				this.addChild(new Text(`  ${ansi.dim(`${i + 1}.`)} ${query.options[i]}`, 0, 0));
			}
		}
		if (query.placeholder) {
			this.addChild(new Text(ansi.dim(`(${query.placeholder})`), 0, 0));
		}
		this.input = new PiInput();
		this.input.onSubmit = (text) => {
			const answer = text.trim();
			if (!answer) return;
			onAnswer(answer);
		};
		this.input.onEscape = () => onCancel();
		this.addChild(this.input);
	}

	getFocusTarget(): PiInput {
		return this.input;
	}

	override render(width: number): string[] {
		return frame(super.render(frameInnerWidth(width)), width);
	}
}
