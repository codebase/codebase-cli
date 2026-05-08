import { Box, Text, useInput } from "ink";
import type { PermissionRequest, ResponseChoice } from "../permissions/store.js";

interface PermissionProps {
	request: PermissionRequest;
	onRespond: (choice: ResponseChoice) => void;
}

const RISK_COLOR: Record<PermissionRequest["risk"], string> = {
	low: "yellow",
	medium: "yellow",
	high: "red",
};

const RISK_GLYPH: Record<PermissionRequest["risk"], string> = {
	low: "?",
	medium: "!",
	high: "‼",
};

/**
 * Modal-ish prompt that takes over the input row while a tool call
 * awaits user approval. Single-keystroke responses keep it fast:
 *   y → allow once    t → trust this tool for the session
 *   a → trust everything    n / Esc → deny
 */
export function Permission({ request, onRespond }: PermissionProps) {
	useInput((input, key) => {
		if (key.escape) {
			onRespond("deny");
			return;
		}
		const ch = input.toLowerCase();
		if (ch === "y") onRespond("allow-once");
		else if (ch === "n") onRespond("deny");
		else if (ch === "t") onRespond("trust-tool");
		else if (ch === "a") onRespond("trust-all");
	});

	const color = RISK_COLOR[request.risk];
	const glyph = RISK_GLYPH[request.risk];

	return (
		<Box flexDirection="column" paddingX={1} marginY={0}>
			<Box>
				<Text color={color} bold>
					{glyph} permission
				</Text>
				<Text> </Text>
				<Text>{request.summary}</Text>
			</Box>
			{request.detail ? (
				<Box marginLeft={2} marginY={0}>
					<Text dimColor>{request.detail}</Text>
				</Box>
			) : null}
			<Box marginTop={0}>
				<Text dimColor>
					[<Text color="green">y</Text>]es · [<Text color="cyan">t</Text>]rust this tool · [
					<Text color="cyan">a</Text>]ll · [<Text color="red">n</Text>]o
				</Text>
			</Box>
		</Box>
	);
}
