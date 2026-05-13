import { Box, Text } from "ink";
import type { BackgroundShellRecord } from "../tools/background-shell-store.js";

interface Props {
	shells: readonly BackgroundShellRecord[];
}

/**
 * Bottom-of-screen list of background shells the agent spawned. Renders
 * nothing when no shells are present so it doesn't take up space in the
 * common case. Each row shows status (running spinner / exit code), id,
 * elapsed time, and the command (truncated).
 */
export function BackgroundShellPanel({ shells }: Props) {
	if (shells.length === 0) return null;
	// Hide rows that exited more than ~10 seconds ago so the panel stays
	// short — recent exits stay long enough for the user to notice, then
	// retire to scrollback. Running shells always show.
	const now = Date.now();
	const visible = shells.filter((s) => s.status === "running" || (s.endedAt && now - s.endedAt < 10_000));
	if (visible.length === 0) return null;
	return (
		<Box flexDirection="column" paddingX={1} marginBottom={1}>
			<Text dimColor>Background shells:</Text>
			{visible.map((s) => {
				const elapsed = Math.round(((s.endedAt ?? now) - s.startedAt) / 1000);
				const status =
					s.status === "running"
						? "● running"
						: s.status === "killed"
							? `× killed${s.signal ? ` ${s.signal}` : ""}`
							: s.exitCode === 0
								? "✓ done"
								: `✗ exit ${s.exitCode ?? "?"}`;
				const color = s.status === "running" ? "magenta" : s.exitCode === 0 ? "green" : "red";
				const cmd = s.command.length > 60 ? `${s.command.slice(0, 60)}…` : s.command;
				return (
					<Box key={`bg-${s.id}`}>
						<Text color={color}>{status}</Text>
						<Text dimColor>
							{" "}
							· {s.id} · {elapsed}s ·{" "}
						</Text>
						<Text>{cmd}</Text>
					</Box>
				);
			})}
		</Box>
	);
}
