import { Box, Text, useApp } from "ink";
import { useEffect, useMemo, useReducer, useState } from "react";
import { type AgentBundle, createAgent } from "../agent/agent.js";
import { ConfigError } from "../agent/config.js";
import { initialState, reducer } from "../agent/events.js";
import { BUILTIN_COMMANDS } from "../commands/builtins.js";
import { CommandRegistry } from "../commands/registry.js";
import type { PermissionRequest } from "../permissions/store.js";
import type { ChatState } from "../types.js";
import type { UserQuery } from "../user-queries/store.js";
import { Input } from "./Input.js";
import { MessageList } from "./MessageList.js";
import { Permission } from "./Permission.js";
import { Status } from "./Status.js";
import { UserQueryView } from "./UserQuery.js";

export function App() {
	const { exit } = useApp();
	let bundle: AgentBundle | undefined;
	let configError: string | undefined;

	try {
		bundle = createAgent();
	} catch (err) {
		configError = err instanceof ConfigError ? err.message : String(err);
	}

	if (!bundle) {
		return (
			<Box flexDirection="column" paddingX={1} paddingY={1}>
				<Text bold color="red">
					configuration error
				</Text>
				<Box marginTop={1}>
					<Text>{configError}</Text>
				</Box>
				<Box marginTop={1}>
					<Text dimColor>Press Ctrl-C to exit.</Text>
				</Box>
				<ExitOnCtrlC onExit={exit} />
			</Box>
		);
	}

	return <ChatApp bundle={bundle} onExit={exit} />;
}

interface ChatAppProps {
	bundle: AgentBundle;
	onExit: () => void;
}

function ChatApp({ bundle, onExit }: ChatAppProps) {
	const [state, dispatch] = useReducer(
		reducer,
		initialState({ provider: bundle.model.provider, id: bundle.model.id, name: bundle.model.name }),
	);
	const [permRequest, setPermRequest] = useState<PermissionRequest | undefined>(bundle.permissions.current());
	const [userQuery, setUserQuery] = useState<UserQuery | undefined>(bundle.userQueries.current());
	const [statusLines, setStatusLines] = useState<string[]>([]);

	const registry = useMemo(() => {
		const reg = new CommandRegistry();
		reg.registerAll(BUILTIN_COMMANDS);
		return reg;
	}, []);

	useEffect(() => {
		const unsubscribe = bundle.subscribe((event) => {
			dispatch({ type: "agent-event", event });
		});
		return unsubscribe;
	}, [bundle]);

	useEffect(() => {
		return bundle.permissions.subscribe((req) => setPermRequest(req));
	}, [bundle]);

	useEffect(() => {
		return bundle.userQueries.subscribe((q) => setUserQuery(q));
	}, [bundle]);

	const busy = state.status === "thinking" || state.status === "streaming" || state.status === "tool";

	const handleSubmit = async (text: string) => {
		// Slash commands first — they bypass the agent.
		if (text.startsWith("/")) {
			const result = await registry.dispatch(text, {
				bundle,
				state: state as ChatState,
				emit: (line: string) => setStatusLines((prev) => [...prev, line]),
				clearDisplay: () => dispatch({ type: "reset" }),
				exit: onExit,
				// Inject the registry so /help can list commands.
				// biome-ignore lint/suspicious/noExplicitAny: cross-cutting injection
				registry,
			} as any);
			if (result.handled) return;
		}

		dispatch({ type: "user-prompt", text });
		bundle.agent.prompt(text).catch((err: unknown) => {
			dispatch({ type: "error", message: err instanceof Error ? err.message : String(err) });
		});
	};

	const handleAbort = () => {
		if (busy) {
			bundle.agent.abort();
			dispatch({ type: "abort" });
		} else {
			onExit();
		}
	};

	return (
		<Box flexDirection="column">
			<Box paddingX={1} paddingY={0} marginBottom={1}>
				<Text bold color="cyan">
					codebase v2
				</Text>
				<Text dimColor>
					{" "}
					· {bundle.model.name} ({bundle.source})
				</Text>
			</Box>
			<MessageList messages={state.messages} streaming={state.streaming} />
			{statusLines.length > 0 ? (
				<Box flexDirection="column" paddingX={1} marginBottom={1}>
					{statusLines.map((line, i) => (
						<Text key={`${i}-${line.slice(0, 8)}`} dimColor>
							{line}
						</Text>
					))}
				</Box>
			) : null}
			<Status state={state} />
			{permRequest ? (
				<Permission
					request={permRequest}
					onRespond={(choice) => bundle.permissions.respond(permRequest.id, choice)}
				/>
			) : userQuery ? (
				<UserQueryView
					query={userQuery}
					onAnswer={(answer) => bundle.userQueries.respond(userQuery.id, answer)}
					onCancel={() => bundle.userQueries.cancel(userQuery.id)}
				/>
			) : (
				<Input disabled={busy} onSubmit={handleSubmit} onAbort={handleAbort} />
			)}
		</Box>
	);
}

function ExitOnCtrlC({ onExit }: { onExit: () => void }) {
	useEffect(() => {
		const handler = () => onExit();
		process.on("SIGINT", handler);
		return () => {
			process.off("SIGINT", handler);
		};
	}, [onExit]);
	return null;
}
