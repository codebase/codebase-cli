import { Box, Text } from "ink";
import type { Task, TaskStatus } from "../tools/task-store.js";

interface TaskPanelProps {
	tasks: readonly Task[];
	/** Cap on tasks rendered before the "+N more" tail. Default 8. */
	maxVisible?: number;
}

const STATUS_GLYPH: Record<TaskStatus, string> = {
	in_progress: "▶",
	pending: "○",
	completed: "✓",
	cancelled: "✗",
};

const STATUS_COLOR: Record<TaskStatus, string | undefined> = {
	in_progress: "magenta",
	pending: undefined,
	completed: "green",
	cancelled: "red",
};

const STATUS_ORDER: Record<TaskStatus, number> = {
	in_progress: 0,
	pending: 1,
	completed: 2,
	cancelled: 3,
};

/**
 * Sticky panel showing the agent's task checklist. Renders nothing
 * when no non-cancelled tasks exist so it doesn't waste a row on an
 * empty session. In-progress tasks show their activeForm (verb-ing
 * label) when supplied — that's the "Adding OAuth refresh" UX rather
 * than the imperative "Add OAuth refresh".
 */
export function TaskPanel({ tasks, maxVisible = 8 }: TaskPanelProps) {
	const visibleSet = tasks.filter((t) => t.status !== "cancelled");
	if (visibleSet.length === 0) return null;
	const sorted = [...visibleSet].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
	const shown = sorted.slice(0, maxVisible);
	const hidden = sorted.length - shown.length;
	const openTaskIds = new Set(
		visibleSet.filter((task) => task.status !== "completed" && task.status !== "cancelled").map((task) => task.id),
	);

	return (
		<Box flexDirection="column" paddingX={1} marginBottom={1}>
			<Text bold dimColor>
				tasks
			</Text>
			{shown.map((task) => (
				<TaskLine key={task.id} task={task} openBlockers={task.blockedBy.filter((id) => openTaskIds.has(id))} />
			))}
			{hidden > 0 ? <Text dimColor>{`  …+${hidden} more`}</Text> : null}
		</Box>
	);
}

function TaskLine({ task, openBlockers }: { task: Task; openBlockers: string[] }) {
	const glyph = STATUS_GLYPH[task.status];
	const color = openBlockers.length > 0 ? "yellow" : STATUS_COLOR[task.status];
	const label = task.status === "in_progress" && task.activeForm ? task.activeForm : task.title;
	const owner = task.owner ? ` @${task.owner}` : "";
	const blocked = openBlockers.length > 0 ? ` blocked by ${openBlockers.join(",")}` : "";
	const blocks = task.blocks.length > 0 ? ` blocks ${task.blocks.join(",")}` : "";
	return (
		<Box>
			<Text color={color}>
				{glyph} {label}
				{owner}
				{blocked}
				{blocks}
			</Text>
		</Box>
	);
}
