import { Box, Text, useInput } from "ink";
import { useState } from "react";

interface InputProps {
	disabled?: boolean;
	onSubmit: (text: string) => void;
	onAbort?: () => void;
}

/**
 * Minimal single-line input. Phase 1 keeps it small; Phase 2+ can swap for
 * a multi-line composer with history and slash-command autocomplete.
 *
 * Keys: printable → buffer; Enter → submit; Backspace → delete; Ctrl-C → abort.
 * Empty submit is dropped so accidental returns don't trigger a turn.
 */
export function Input({ disabled, onSubmit, onAbort }: InputProps) {
	const [buffer, setBuffer] = useState("");

	useInput((input, key) => {
		if (key.ctrl && input === "c") {
			onAbort?.();
			return;
		}

		if (disabled) return;

		if (key.return) {
			const trimmed = buffer.trim();
			if (trimmed.length > 0) {
				onSubmit(trimmed);
				setBuffer("");
			}
			return;
		}

		if (key.backspace || key.delete) {
			setBuffer((b) => b.slice(0, -1));
			return;
		}

		if (input && !key.ctrl && !key.meta) {
			setBuffer((b) => b + input);
		}
	});

	return (
		<Box paddingX={1}>
			<Text color={disabled ? "gray" : "cyan"}>{disabled ? "·" : ">"} </Text>
			<Text>{buffer}</Text>
			{!disabled ? <Text color="cyan">▎</Text> : null}
		</Box>
	);
}
