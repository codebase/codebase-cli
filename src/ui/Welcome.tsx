import { basename } from "node:path";
import { Box, Text } from "ink";
import { PixelC } from "./PixelC.js";

interface WelcomeProps {
	modelName: string;
	source: string;
	cwd: string;
}

/**
 * Empty-state banner shown above the input while the transcript is
 * empty. Pixel-C logo on the left, contextual info + tips on the
 * right. Renders once and gets pushed up by the first user message —
 * not Static-rendered, but only a few rows so it's cheap.
 */
export function Welcome({ modelName, source, cwd }: WelcomeProps) {
	const cwdLabel = basename(cwd) || cwd;
	const sourceLabel = source === "proxy" ? "signed in via codebase.design" : source === "byok" ? "BYOK" : `${source}`;

	return (
		<Box flexDirection="column" paddingX={1} marginBottom={1}>
			<Box flexDirection="row">
				<Box marginRight={2}>
					<PixelC animate={false} />
				</Box>
				<Box flexDirection="column" justifyContent="center">
					<Text bold color="cyan">
						codebase
					</Text>
					<Text dimColor>{modelName}</Text>
					<Text dimColor>
						{cwdLabel} · {sourceLabel}
					</Text>
				</Box>
			</Box>
			<Box marginTop={1} flexDirection="column">
				<Text dimColor>Ask me to read code, edit files, run commands, or anything in between.</Text>
				<Text dimColor>
					<Text color="cyan">/</Text> commands · <Text color="cyan">!</Text>shell · <Text color="cyan">↑↓</Text>{" "}
					history · <Text color="cyan">Tab</Text> complete · <Text color="cyan">\</Text>+Enter for newline
				</Text>
				<Text dimColor>Ctrl-C twice to exit.</Text>
			</Box>
		</Box>
	);
}
