import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useState } from "react";
import { CredentialsStore } from "../auth/credentials.js";
import { type OAuthConfig, runOAuthLogin } from "../auth/flow.js";

const DEFAULT_AUTH_BASE = "https://codebase.design";

interface ProviderChoice {
	id: string;
	label: string;
	hint: string;
	keyHint: string;
}

const PROVIDER_CHOICES: readonly ProviderChoice[] = [
	{ id: "anthropic", label: "Anthropic (Claude)", hint: "claude-sonnet-4 default", keyHint: "sk-ant-…" },
	{ id: "openai", label: "OpenAI (GPT-5)", hint: "gpt-5.1 default", keyHint: "sk-…" },
	{ id: "groq", label: "Groq", hint: "Llama 3.3 70B, free tier", keyHint: "gsk_…" },
	{ id: "openrouter", label: "OpenRouter", hint: "any model via one key", keyHint: "sk-or-…" },
	{ id: "google", label: "Google (Gemini)", hint: "gemini-2.5-pro default", keyHint: "AI…" },
	{ id: "mistral", label: "Mistral", hint: "mistral-large-latest", keyHint: "" },
	{ id: "deepseek", label: "DeepSeek", hint: "deepseek-chat", keyHint: "" },
	{ id: "xai", label: "xAI (Grok)", hint: "grok-4", keyHint: "xai-…" },
	{ id: "cerebras", label: "Cerebras", hint: "fastest inference", keyHint: "" },
] as const;

interface FirstRunSetupProps {
	/** Called once a credential has been persisted and config can be re-resolved. */
	onDone: () => void;
	/** Called when the user explicitly quits the wizard. */
	onQuit: () => void;
	store?: CredentialsStore;
	authBase?: string;
}

type Mode =
	| { kind: "menu" }
	| { kind: "oauth-running" }
	| { kind: "byok-provider" }
	| { kind: "byok-key"; provider: ProviderChoice; buffer: string }
	| { kind: "error"; message: string };

interface ManualUrlInfo {
	url: string;
	reason: string;
}

export function FirstRunSetup({ onDone, onQuit, store, authBase = DEFAULT_AUTH_BASE }: FirstRunSetupProps) {
	const [mode, setMode] = useState<Mode>({ kind: "menu" });
	const [manualUrl, setManualUrl] = useState<ManualUrlInfo | undefined>(undefined);
	const credStore = useMemo(() => store ?? new CredentialsStore(), [store]);

	useEffect(() => {
		if (mode.kind !== "oauth-running") return;
		let cancelled = false;
		(async () => {
			try {
				const config = oauthConfigForBase(authBase);
				const creds = await runOAuthLogin(config, {
					onManualUrl: (url, reason) => {
						if (cancelled) return;
						setManualUrl({ url, reason });
					},
				});
				if (cancelled) return;
				credStore.save({
					accessToken: creds.accessToken,
					refreshToken: creds.refreshToken,
					expiresAt: creds.expiresAt,
					scopes: creds.scopes,
					userId: creds.userId,
					email: creds.email,
					source: "codebase",
				});
				onDone();
			} catch (err) {
				if (cancelled) return;
				setMode({ kind: "error", message: err instanceof Error ? err.message : String(err) });
				setManualUrl(undefined);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [mode.kind, authBase, credStore, onDone]);

	useInput(
		(input, key) => {
			if (key.ctrl && input === "c") {
				onQuit();
				return;
			}
			if (mode.kind === "menu") {
				if (input === "1") {
					setMode({ kind: "oauth-running" });
				} else if (input === "2") {
					setMode({ kind: "byok-provider" });
				} else if (input === "3" || input === "q") {
					onQuit();
				}
				return;
			}
			if (mode.kind === "byok-provider") {
				if (key.escape) {
					setMode({ kind: "menu" });
					return;
				}
				const idx = Number.parseInt(input, 10) - 1;
				if (Number.isInteger(idx) && idx >= 0 && idx < PROVIDER_CHOICES.length) {
					setMode({ kind: "byok-key", provider: PROVIDER_CHOICES[idx], buffer: "" });
				}
				return;
			}
			if (mode.kind === "byok-key") {
				if (key.escape) {
					setMode({ kind: "byok-provider" });
					return;
				}
				if (key.return) {
					const trimmed = mode.buffer.trim();
					if (trimmed.length === 0) return;
					try {
						credStore.save({
							accessToken: trimmed,
							scopes: [],
							source: "byok",
							provider: mode.provider.id,
						});
						onDone();
					} catch (err) {
						setMode({
							kind: "error",
							message: err instanceof Error ? err.message : String(err),
						});
					}
					return;
				}
				if (key.backspace || key.delete) {
					setMode({ ...mode, buffer: mode.buffer.slice(0, -1) });
					return;
				}
				if (input && !key.ctrl && !key.meta) {
					setMode({ ...mode, buffer: mode.buffer + input });
				}
				return;
			}
			if (mode.kind === "error") {
				if (key.return || key.escape || input === " ") {
					setMode({ kind: "menu" });
				}
			}
		},
		{ isActive: mode.kind !== "oauth-running" },
	);

	return (
		<Box flexDirection="column" paddingX={1} paddingY={1}>
			<Box marginBottom={1}>
				<Text bold color="cyan">
					Welcome to codebase
				</Text>
			</Box>
			<Box marginBottom={1}>
				<Text dimColor>Pick how you want to power the agent. You can change this later via `codebase auth`.</Text>
			</Box>
			{renderBody(mode, authBase, manualUrl)}
		</Box>
	);
}

function renderBody(mode: Mode, authBase: string, manualUrl: ManualUrlInfo | undefined): React.ReactNode {
	if (mode.kind === "menu") {
		return (
			<Box flexDirection="column">
				<Text>
					<Text color="green">1.</Text> Sign in with codebase.design{"  "}
					<Text dimColor>— OAuth via browser, free Claude credits, account-curated skills</Text>
				</Text>
				<Text>
					<Text color="green">2.</Text> Bring your own LLM key{"   "}
					<Text dimColor>— paste an Anthropic / OpenAI / Groq / etc. key</Text>
				</Text>
				<Text>
					<Text color="green">3.</Text> Quit
				</Text>
				<Box marginTop={1}>
					<Text dimColor>Press 1, 2, or 3.</Text>
				</Box>
			</Box>
		);
	}
	if (mode.kind === "oauth-running") {
		if (manualUrl) {
			return (
				<Box flexDirection="column">
					<Text bold color="yellow">
						Open this URL in your browser to sign in:
					</Text>
					<Box marginTop={1}>
						<Text dimColor>({manualUrl.reason})</Text>
					</Box>
					<Box marginTop={1}>
						<Text>{osc8Link(manualUrl.url, "→ Click here to sign in")}</Text>
					</Box>
					<Box marginTop={1} flexDirection="column">
						<Text dimColor>Or copy the URL below and paste it into a browser:</Text>
						<Text>{manualUrl.url}</Text>
					</Box>
					<Box marginTop={1}>
						<Text dimColor>Waiting for the browser to redirect back here. (Ctrl-C to cancel.)</Text>
					</Box>
				</Box>
			);
		}
		return (
			<Box flexDirection="column">
				<Text>
					Opening <Text color="cyan">{authBase}</Text> in your browser…
				</Text>
				<Box marginTop={1}>
					<Text dimColor>Complete sign-in in the browser tab. This window will continue automatically.</Text>
				</Box>
			</Box>
		);
	}
	if (mode.kind === "byok-provider") {
		return (
			<Box flexDirection="column">
				<Text bold>Pick a provider:</Text>
				<Box flexDirection="column" marginLeft={2} marginTop={1}>
					{PROVIDER_CHOICES.map((p, i) => (
						<Text key={p.id}>
							<Text color="green">{`${i + 1}. `}</Text>
							{p.label}
							<Text dimColor>{`  — ${p.hint}`}</Text>
						</Text>
					))}
				</Box>
				<Box marginTop={1}>
					<Text dimColor>Press 1–{PROVIDER_CHOICES.length}, or Esc to go back.</Text>
				</Box>
			</Box>
		);
	}
	if (mode.kind === "byok-key") {
		const masked = "•".repeat(Math.min(mode.buffer.length, 40));
		return (
			<Box flexDirection="column">
				<Text bold>
					Paste your {mode.provider.label} API key
					{mode.provider.keyHint ? <Text dimColor>{` (${mode.provider.keyHint})`}</Text> : null}
				</Text>
				<Box marginTop={1}>
					<Text color="cyan">{"> "}</Text>
					<Text>{masked}</Text>
					<Text color="magenta">▎</Text>
				</Box>
				<Box marginTop={1}>
					<Text dimColor>
						Stored at ~/.codebase/credentials.json (mode 0600). Press Enter to save, Esc to go back.
					</Text>
				</Box>
			</Box>
		);
	}
	// error
	return (
		<Box flexDirection="column">
			<Text bold color="red">
				That didn't work
			</Text>
			<Box marginTop={1}>
				<Text>{mode.message}</Text>
			</Box>
			<Box marginTop={1}>
				<Text dimColor>Press Enter to return to the menu.</Text>
			</Box>
		</Box>
	);
}

// Mirrors src/auth/cli.ts's defaultOAuthConfig — see that file for the
// canonical shape and the OAuth alignment audit.
/**
 * Wrap text in an OSC 8 hyperlink escape so it renders as a single
 * clickable element regardless of how the terminal wraps the visible
 * text. Modern terminals (iTerm2, recent Terminal.app, Kitty,
 * Wezterm, Alacritty, VSCode terminal) honor this; older terminals
 * just see the display text. We always render the bare URL on a
 * separate line below as a copy-paste fallback.
 */
function osc8Link(url: string, displayText: string): string {
	const ESC = "";
	return `${ESC}]8;;${url}${ESC}\\${displayText}${ESC}]8;;${ESC}\\`;
}

function oauthConfigForBase(base: string): OAuthConfig {
	const trimmed = base.replace(/\/+$/, "");
	return {
		authorizationUrl: `${trimmed}/login`,
		tokenUrl: `${trimmed}/api/oauth/token`,
		refreshUrl: `${trimmed}/api/oauth/token`,
		revokeUrl: `${trimmed}/api/oauth/revoke`,
		clientId: process.env.CODEBASE_CLIENT_ID ?? "codebase-cli",
		scopes: (process.env.CODEBASE_SCOPES ?? "inference projects credits").split(/\s+/).filter(Boolean),
	};
}
