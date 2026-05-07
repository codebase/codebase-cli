#!/usr/bin/env node
import { Box, render, Text, useApp, useInput } from "ink";

function App() {
	const { exit } = useApp();

	useInput((input, key) => {
		if (key.escape || (key.ctrl && input === "c") || input === "q") {
			exit();
		}
	});

	return (
		<Box flexDirection="column" paddingX={1} paddingY={1}>
			<Text bold color="cyan">
				codebase v2
			</Text>
			<Text dimColor>Phase 0 scaffolding — TypeScript on pi-mono runtime</Text>
			<Box marginTop={1}>
				<Text>
					Press <Text color="yellow">q</Text> or <Text color="yellow">Ctrl-C</Text> to exit.
				</Text>
			</Box>
		</Box>
	);
}

render(<App />);
