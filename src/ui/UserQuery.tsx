import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { UserQuery } from "../user-queries/store.js";

interface UserQueryProps {
	query: UserQuery;
	onAnswer: (answer: string) => void;
	onCancel: () => void;
}

/**
 * Free-form text input for the ask_user tool. Mirrors Input.tsx but
 * with a question header above and routes its result to the user-query
 * store instead of the chat reducer.
 */
export function UserQueryView({ query, onAnswer, onCancel }: UserQueryProps) {
	const [buffer, setBuffer] = useState("");

	useInput((input, key) => {
		if (key.ctrl && input === "c") {
			onCancel();
			return;
		}
		if (key.escape) {
			onCancel();
			return;
		}
		if (key.return) {
			const trimmed = buffer.trim();
			if (trimmed.length > 0) {
				onAnswer(trimmed);
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
		<Box flexDirection="column" paddingX={1} marginY={0}>
			<Box>
				<Text bold color="magenta">
					? {query.question}
				</Text>
			</Box>
			{query.options && query.options.length > 0 ? (
				<Box flexDirection="column" marginLeft={2}>
					{query.options.map((option, i) => (
						<Text key={`${i}-${option}`} dimColor>
							{`${i + 1}. ${option}`}
						</Text>
					))}
				</Box>
			) : null}
			<Box>
				<Text color="magenta">{"> "}</Text>
				<Text>{buffer}</Text>
				<Text color="magenta">▎</Text>
			</Box>
			{query.placeholder ? (
				<Box marginLeft={2}>
					<Text dimColor>{query.placeholder}</Text>
				</Box>
			) : null}
		</Box>
	);
}
