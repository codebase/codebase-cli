import { Box, Text, useInput } from "ink";
import { useState } from "react";
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

const RISK_LABEL: Record<PermissionRequest["risk"], string> = {
	low: "LOW RISK",
	medium: "REVIEW",
	high: "HIGH RISK",
};

interface ChoiceSpec {
	label: string;
	key: ResponseChoice;
	hint: string;
	color: "green" | "cyan" | "red";
	shortcut: string;
}

const CHOICES: readonly ChoiceSpec[] = [
	{ label: "Allow", key: "allow-once", hint: "this one time", color: "green", shortcut: "y" },
	{ label: "Trust tool", key: "trust-tool", hint: "for the rest of this session", color: "cyan", shortcut: "t" },
	{ label: "Trust all", key: "trust-all", hint: "any tool, this session", color: "cyan", shortcut: "a" },
	{ label: "Deny", key: "deny", hint: "block this call", color: "red", shortcut: "n" },
];

/**
 * Permission prompt — bordered box with risk badge, tool summary,
 * collapsed detail, and four arrow-navigable choices. Single-key
 * shortcuts still work (y/t/a/n) for muscle memory; Enter on the
 * highlighted choice for newcomers; Esc maps to Deny.
 */
export function Permission({ request, onRespond }: PermissionProps) {
	const [cursor, setCursor] = useState(0);

	useInput((input, key) => {
		if (key.escape) {
			onRespond("deny");
			return;
		}
		if (key.return) {
			onRespond(CHOICES[cursor].key);
			return;
		}
		if (key.leftArrow || (key.shift && key.tab)) {
			setCursor((c) => (c - 1 + CHOICES.length) % CHOICES.length);
			return;
		}
		if (key.rightArrow || key.tab || key.downArrow || key.upArrow) {
			setCursor((c) => (c + 1) % CHOICES.length);
			return;
		}
		const ch = input.toLowerCase();
		const direct = CHOICES.find((c) => c.shortcut === ch);
		if (direct) onRespond(direct.key);
	});

	const riskColor = RISK_COLOR[request.risk];
	const riskLabel = RISK_LABEL[request.risk];

	return (
		<Box flexDirection="column" borderStyle="round" borderColor={riskColor} paddingX={1} marginY={0}>
			<Box>
				<Text color={riskColor} bold>
					{riskLabel}
				</Text>
				<Text> </Text>
				<Text dimColor>· permission needed</Text>
			</Box>
			<Box marginTop={1}>
				<Text bold>{request.tool}</Text>
				<Text dimColor>{"  "}</Text>
				<Text>{request.summary}</Text>
			</Box>
			{request.detail ? (
				<Box marginTop={1} flexDirection="column">
					<Text dimColor>{truncate(request.detail, 600)}</Text>
				</Box>
			) : null}
			<Box marginTop={1} flexDirection="row">
				{CHOICES.map((c, i) => {
					const selected = i === cursor;
					return (
						<Box key={c.key} marginRight={2}>
							<Text color={selected ? c.color : "gray"} bold={selected}>
								{selected ? "▸ " : "  "}
								{c.label}
							</Text>
							<Text dimColor> ({c.shortcut})</Text>
						</Box>
					);
				})}
			</Box>
			<Box marginTop={1}>
				<Text dimColor>{CHOICES[cursor].hint} · ←→ Enter · y/t/a/n shortcuts · Esc to deny</Text>
			</Box>
		</Box>
	);
}

function truncate(s: string, n: number): string {
	if (s.length <= n) return s;
	return `${s.slice(0, n - 1)}…`;
}
