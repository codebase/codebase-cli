import { Box, Text } from "ink";
import type { ChatState } from "../types.js";
import { Throbber } from "./Throbber.js";

interface StatusProps {
	state: ChatState;
}

const STATUS_LABEL: Record<ChatState["status"], string> = {
	idle: "ready",
	thinking: "thinking",
	streaming: "responding",
	tool: "tool",
	aborted: "aborted",
	error: "error",
};

const STATUS_COLOR: Record<ChatState["status"], string> = {
	idle: "green",
	thinking: "yellow",
	streaming: "cyan",
	tool: "magenta",
	aborted: "red",
	error: "red",
};

export function Status({ state }: StatusProps) {
	const busy = state.status === "thinking" || state.status === "streaming" || state.status === "tool";
	const label = STATUS_LABEL[state.status];
	const color = STATUS_COLOR[state.status];
	const u = state.usage;

	return (
		<Box flexDirection="column">
			{state.error ? (
				<Box paddingX={1}>
					<Text color="red">! {state.error}</Text>
				</Box>
			) : null}
			<Box paddingX={1} justifyContent="space-between">
				<Box>
					{busy ? (
						<>
							<Throbber color={color} />
							<Text> </Text>
						</>
					) : null}
					<Text color={color}>{label}</Text>
				</Box>
				<Box>
					<Text dimColor>
						{state.model.provider}/{state.model.id} · ↓{u.input} ↑{u.output} ${formatCost(u.cost.total)}
					</Text>
				</Box>
			</Box>
		</Box>
	);
}

function formatCost(value: number): string {
	if (value === 0) return "0.0000";
	if (value < 0.01) return value.toFixed(4);
	return value.toFixed(2);
}
