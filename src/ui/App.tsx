import { Box, Text, useApp } from "ink";
import { useEffect, useReducer, useState } from "react";
import { type AgentBundle, createAgent } from "../agent/agent.js";
import { ConfigError } from "../agent/config.js";
import { initialState, reducer } from "../agent/events.js";
import type { PermissionRequest } from "../permissions/store.js";
import { Input } from "./Input.js";
import { MessageList } from "./MessageList.js";
import { Permission } from "./Permission.js";
import { Status } from "./Status.js";

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

	useEffect(() => {
		const unsubscribe = bundle.subscribe((event) => {
			dispatch({ type: "agent-event", event });
		});
		return unsubscribe;
	}, [bundle]);

	useEffect(() => {
		return bundle.permissions.subscribe((req) => setPermRequest(req));
	}, [bundle]);

	const busy = state.status === "thinking" || state.status === "streaming" || state.status === "tool";

	const handleSubmit = (text: string) => {
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
			<Status state={state} />
			{permRequest ? (
				<Permission
					request={permRequest}
					onRespond={(choice) => bundle.permissions.respond(permRequest.id, choice)}
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
