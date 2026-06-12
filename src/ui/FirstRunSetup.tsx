import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";
import { CredentialsStore } from "../auth/credentials.js";
import { type OAuthConfig, type PasteResult, runOAuthLogin } from "../auth/flow.js";
import { type DiscoveredServer, formatContextWindow, SCAN_PORTS, scanLocalEndpoints } from "../config/local-llm.js";
import { PixelC } from "./PixelC.js";

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
	{
		id: "openai-compat",
		label: "OpenAI-compatible endpoint",
		hint: "Ollama / LM Studio / vLLM / any base URL",
		keyHint: "",
	},
] as const;

type CompatStep = "url" | "model" | "key";

const COMPAT_PROMPTS: Record<CompatStep, { title: string; hint: string }> = {
	url: {
		title: "Endpoint base URL",
		hint: "e.g. http://localhost:11434/v1 (Ollama) or https://my-proxy.example.com/v1",
	},
	model: { title: "Model id", hint: "the model name the server expects, e.g. llama3.3:70b or qwen2.5-coder" },
	key: { title: "API key", hint: "Enter to skip if your server doesn't need one" },
};

interface ScanRow {
	serverLabel: string;
	baseUrl: string;
	model: string;
	contextWindow?: number;
}

/** Cap models shown per server so a big Ollama library doesn't swamp the list. */
const MAX_MODELS_PER_SERVER = 6;

function flattenScan(servers: DiscoveredServer[]): ScanRow[] {
	const rows: ScanRow[] = [];
	for (const s of servers) {
		for (const m of s.models.slice(0, MAX_MODELS_PER_SERVER)) {
			rows.push({ serverLabel: s.label, baseUrl: s.baseUrl, model: m.id, contextWindow: m.contextWindow });
		}
	}
	return rows;
}

interface FirstRunSetupProps {
	/** Called once a credential has been persisted and config can be re-resolved. */
	onDone: () => void;
	/** Called when the user explicitly quits the wizard. */
	onQuit: () => void;
	store?: CredentialsStore;
	authBase?: string;
}

const MENU_OPTIONS = [
	{ key: "oauth", label: "Login to Codebase", hint: "free credits · Codebase Auto model · curated skills" },
	{
		key: "byok",
		label: "Bring your own LLM key",
		hint: "Anthropic / OpenAI / Groq key, or any OpenAI-compatible endpoint",
	},
	{ key: "quit", label: "Quit", hint: "exit the wizard" },
] as const;

type Mode =
	| { kind: "menu"; cursor: number }
	| { kind: "oauth-running" }
	| { kind: "byok-provider"; cursor: number }
	| { kind: "byok-key"; provider: ProviderChoice; buffer: string }
	| { kind: "byok-scan"; rows: ScanRow[] | undefined; cursor: number }
	| { kind: "byok-compat"; step: CompatStep; url: string; model: string; buffer: string }
	| { kind: "error"; message: string };

interface ManualUrlInfo {
	url: string;
	reason: string;
}

export function FirstRunSetup({ onDone, onQuit, store, authBase = DEFAULT_AUTH_BASE }: FirstRunSetupProps) {
	const [mode, setMode] = useState<Mode>({ kind: "menu", cursor: 0 });
	const [manualUrl, setManualUrl] = useState<ManualUrlInfo | undefined>(undefined);
	const [pasteBuffer, setPasteBuffer] = useState("");
	const [pasteError, setPasteError] = useState<string | undefined>(undefined);
	const submitPasteRef = useRef<((input: string) => PasteResult) | null>(null);
	const credStore = useMemo(() => store ?? new CredentialsStore(), [store]);

	useEffect(() => {
		if (mode.kind !== "oauth-running") return;
		let cancelled = false;
		// Reset paste-fallback state each time we enter oauth-running so a
		// retry doesn't show stale errors from the previous attempt.
		setPasteBuffer("");
		setPasteError(undefined);
		submitPasteRef.current = null;
		(async () => {
			try {
				const config = oauthConfigForBase(authBase);
				const creds = await runOAuthLogin(config, {
					onManualUrl: (url, reason) => {
						if (cancelled) return;
						setManualUrl({ url, reason });
					},
					onPasteFallback: (submit) => {
						if (cancelled) return;
						submitPasteRef.current = submit;
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

	useEffect(() => {
		if (mode.kind !== "byok-scan") return;
		let cancelled = false;
		(async () => {
			const servers = await scanLocalEndpoints();
			if (cancelled) return;
			setMode((m) => (m.kind === "byok-scan" && !m.rows ? { ...m, rows: flattenScan(servers) } : m));
		})();
		return () => {
			cancelled = true;
		};
	}, [mode.kind]);

	useInput(
		(input, key) => {
			if (key.ctrl && input === "c") {
				onQuit();
				return;
			}
			if (mode.kind === "menu") {
				if (key.upArrow || (key.shift && key.tab)) {
					setMode({ kind: "menu", cursor: (mode.cursor - 1 + MENU_OPTIONS.length) % MENU_OPTIONS.length });
					return;
				}
				if (key.downArrow || key.tab) {
					setMode({ kind: "menu", cursor: (mode.cursor + 1) % MENU_OPTIONS.length });
					return;
				}
				if (key.return) {
					applyMenuChoice(MENU_OPTIONS[mode.cursor].key);
					return;
				}
				// Number-key fast-path stays for muscle memory.
				if (input === "1") applyMenuChoice("oauth");
				else if (input === "2") applyMenuChoice("byok");
				else if (input === "3" || input === "q") applyMenuChoice("quit");
				return;
			}
			if (mode.kind === "byok-provider") {
				if (key.escape) {
					setMode({ kind: "menu", cursor: 1 });
					return;
				}
				if (key.upArrow || (key.shift && key.tab)) {
					setMode({
						kind: "byok-provider",
						cursor: (mode.cursor - 1 + PROVIDER_CHOICES.length) % PROVIDER_CHOICES.length,
					});
					return;
				}
				if (key.downArrow || key.tab) {
					setMode({ kind: "byok-provider", cursor: (mode.cursor + 1) % PROVIDER_CHOICES.length });
					return;
				}
				if (key.return) {
					pickProvider(PROVIDER_CHOICES[mode.cursor]);
					return;
				}
				// Number-key fast-path stays.
				const idx = Number.parseInt(input, 10) - 1;
				if (Number.isInteger(idx) && idx >= 0 && idx < PROVIDER_CHOICES.length) {
					pickProvider(PROVIDER_CHOICES[idx]);
				}
				return;
			}
			if (mode.kind === "byok-scan") {
				if (key.escape) {
					setMode({ kind: "byok-provider", cursor: 0 });
					return;
				}
				if (!mode.rows) return; // still scanning — only Esc works
				const total = mode.rows.length + 1; // +1 for "enter manually"
				if (key.upArrow || (key.shift && key.tab)) {
					setMode({ ...mode, cursor: (mode.cursor - 1 + total) % total });
					return;
				}
				if (key.downArrow || key.tab) {
					setMode({ ...mode, cursor: (mode.cursor + 1) % total });
					return;
				}
				if (key.return) {
					const row = mode.rows[mode.cursor];
					if (row) saveCompat(row.baseUrl, row.model, "none", row.contextWindow);
					else setMode({ kind: "byok-compat", step: "url", url: "", model: "", buffer: "" });
				}
				return;
			}
			if (mode.kind === "byok-compat") {
				if (key.escape) {
					// Step back one field; from the first field, back to the scan list.
					if (mode.step === "key") setMode({ ...mode, step: "model", buffer: mode.model });
					else if (mode.step === "model") setMode({ ...mode, step: "url", buffer: mode.url });
					else setMode({ kind: "byok-scan", rows: undefined, cursor: 0 });
					return;
				}
				if (key.return) {
					const trimmed = mode.buffer.trim();
					if (mode.step === "url") {
						if (!/^https?:\/\//.test(trimmed)) return;
						setMode({ ...mode, step: "model", url: trimmed, buffer: mode.model });
						return;
					}
					if (mode.step === "model") {
						if (trimmed.length === 0) return;
						setMode({ ...mode, step: "key", model: trimmed, buffer: "" });
						return;
					}
					saveCompat(mode.url, mode.model, trimmed.length > 0 ? trimmed : "none");
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
			if (mode.kind === "byok-key") {
				if (key.escape) {
					setMode({ kind: "byok-provider", cursor: 0 });
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
					setMode({ kind: "menu", cursor: 0 });
				}
			}
			if (mode.kind === "oauth-running") {
				// Esc cancels back to the menu. Submit the buffer on Enter;
				// printable input + backspace edit it. The paste-fallback
				// channel is only wired once the auth URL exists — until
				// then we accept input but submit is a no-op.
				if (key.escape) {
					onQuit();
					return;
				}
				if (key.return) {
					const trimmed = pasteBuffer.trim();
					if (!trimmed || !submitPasteRef.current) return;
					const result = submitPasteRef.current(trimmed);
					if (result.ok) {
						// Flow resolves; the useEffect handles credStore + onDone.
						setPasteError(undefined);
					} else {
						setPasteError(result.error);
						setPasteBuffer("");
					}
					return;
				}
				if (key.backspace || key.delete) {
					setPasteBuffer((p) => p.slice(0, -1));
					return;
				}
				if (input && !key.ctrl && !key.meta) {
					setPasteBuffer((p) => p + input);
				}
			}
		},
		{ isActive: true },
	);

	function applyMenuChoice(choice: "oauth" | "byok" | "quit"): void {
		if (choice === "oauth") setMode({ kind: "oauth-running" });
		else if (choice === "byok") setMode({ kind: "byok-provider", cursor: 0 });
		else onQuit();
	}

	function pickProvider(provider: ProviderChoice): void {
		if (provider.id === "openai-compat") {
			setMode({ kind: "byok-scan", rows: undefined, cursor: 0 });
		} else {
			setMode({ kind: "byok-key", provider, buffer: "" });
		}
	}

	function saveCompat(baseUrl: string, model: string, key: string, contextWindow?: number): void {
		try {
			credStore.save({
				// Servers without auth still get a syntactically-valid
				// bearer; Ollama / LM Studio ignore it entirely.
				accessToken: key,
				scopes: [],
				source: "byok",
				provider: "openai-compat",
				baseUrl: baseUrl.replace(/\/+$/, ""),
				model,
				contextWindow,
			});
			onDone();
		} catch (err) {
			setMode({ kind: "error", message: err instanceof Error ? err.message : String(err) });
		}
	}

	return (
		<Box flexDirection="column" paddingX={1} paddingY={1}>
			<BrandHeader />
			<Box marginBottom={1}>
				<Text dimColor>Pick how you want to power the agent. You can change this later via `codebase auth`.</Text>
			</Box>
			{renderBody(mode, authBase, manualUrl, pasteBuffer, pasteError)}
		</Box>
	);
}

/**
 * Branded header — static pixel C + "codebase" wordmark.
 */
function BrandHeader(): React.ReactNode {
	return (
		<Box flexDirection="row" marginBottom={1}>
			<Box marginRight={2}>
				<PixelC />
			</Box>
			<Box flexDirection="column" justifyContent="center">
				<Text bold color="cyan">
					codebase
				</Text>
				<Text dimColor>AI coding agent · CLI</Text>
			</Box>
		</Box>
	);
}

function renderBody(
	mode: Mode,
	authBase: string,
	manualUrl: ManualUrlInfo | undefined,
	pasteBuffer: string,
	pasteError: string | undefined,
): React.ReactNode {
	if (mode.kind === "menu") {
		return (
			<Box flexDirection="column">
				{MENU_OPTIONS.map((opt, i) => {
					const selected = i === mode.cursor;
					return (
						<Text key={opt.key}>
							<Text color={selected ? "cyan" : "gray"}>{selected ? "▸ " : "  "}</Text>
							<Text bold={selected} color={selected ? "white" : undefined}>
								{opt.label}
							</Text>
							<Text dimColor>{"   — " + opt.hint}</Text>
						</Text>
					);
				})}
				<Box marginTop={1}>
					<Text dimColor>↑↓ to move · Enter to select · 1/2/3 fast-path · Ctrl-C to quit</Text>
				</Box>
			</Box>
		);
	}
	if (mode.kind === "oauth-running") {
		if (manualUrl) {
			return (
				<Box flexDirection="column">
					<Text bold color="yellow">
						Sign in to continue
					</Text>
					<Box marginTop={1}>
						<Text dimColor>Opening browser automatically. If it didn't open, copy the URL below:</Text>
					</Box>
					<Box marginTop={1}>
						<Text color="cyan">{manualUrl.url}</Text>
					</Box>
					<Box marginTop={1}>
						<Text dimColor>Waiting for the browser to redirect back.</Text>
					</Box>
					<Box marginTop={1} flexDirection="column">
						<Text dimColor>
							Redirect failed? Paste the http://127.0.0.1/callback?... URL from your browser here:
						</Text>
						<Box>
							<Text color="cyan">{"> "}</Text>
							<Text>{pasteBuffer}</Text>
							<Text color="cyan">▎</Text>
						</Box>
						{pasteError ? <Text color="red">{pasteError}</Text> : null}
					</Box>
					<Box marginTop={1}>
						<Text dimColor>Enter to submit · Esc to cancel</Text>
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
				<Box flexDirection="column" marginTop={1}>
					{PROVIDER_CHOICES.map((p, i) => {
						const selected = i === mode.cursor;
						return (
							<Text key={p.id}>
								<Text color={selected ? "cyan" : "gray"}>{selected ? "▸ " : "  "}</Text>
								<Text bold={selected} color={selected ? "white" : undefined}>
									{p.label}
								</Text>
								<Text dimColor>{"  — " + p.hint}</Text>
							</Text>
						);
					})}
				</Box>
				<Box marginTop={1}>
					<Text dimColor>
						↑↓ to move · Enter to select · 1–{PROVIDER_CHOICES.length} fast-path · Esc to go back
					</Text>
				</Box>
			</Box>
		);
	}
	if (mode.kind === "byok-scan") {
		if (!mode.rows) {
			return (
				<Box flexDirection="column">
					<Text bold>Looking for local LLM servers…</Text>
					<Box marginTop={1}>
						<Text dimColor>Scanning localhost ports {SCAN_PORTS.join(", ")} (LM Studio, Ollama, vLLM, …)</Text>
					</Box>
					<Box marginTop={1}>
						<Text dimColor>Esc to skip</Text>
					</Box>
				</Box>
			);
		}
		const manualSelected = mode.cursor === mode.rows.length;
		return (
			<Box flexDirection="column">
				<Text bold>{mode.rows.length > 0 ? "Found local models:" : "No local LLM servers found."}</Text>
				<Box flexDirection="column" marginTop={1}>
					{mode.rows.map((row, i) => {
						const selected = i === mode.cursor;
						const ctx = formatContextWindow(row.contextWindow);
						return (
							<Text key={`${row.baseUrl}/${row.model}`}>
								<Text color={selected ? "cyan" : "gray"}>{selected ? "▸ " : "  "}</Text>
								<Text bold={selected} color={selected ? "white" : undefined}>
									{row.model}
								</Text>
								<Text dimColor>{`  — ${row.serverLabel}${ctx ? ` · ${ctx}` : ""} · ${row.baseUrl}`}</Text>
							</Text>
						);
					})}
					<Text>
						<Text color={manualSelected ? "cyan" : "gray"}>{manualSelected ? "▸ " : "  "}</Text>
						<Text bold={manualSelected} color={manualSelected ? "white" : undefined}>
							Enter URL manually…
						</Text>
					</Text>
				</Box>
				<Box marginTop={1}>
					<Text dimColor>↑↓ to move · Enter to select · Esc to go back</Text>
				</Box>
			</Box>
		);
	}
	if (mode.kind === "byok-compat") {
		const prompt = COMPAT_PROMPTS[mode.step];
		const stepNum = mode.step === "url" ? 1 : mode.step === "model" ? 2 : 3;
		const shown = mode.step === "key" ? "•".repeat(Math.min(mode.buffer.length, 40)) : mode.buffer;
		return (
			<Box flexDirection="column">
				<Text bold>
					OpenAI-compatible endpoint <Text dimColor>{`· step ${stepNum}/3`}</Text>
				</Text>
				{mode.url ? (
					<Text dimColor>
						{"  url: "}
						{mode.url}
					</Text>
				) : null}
				{mode.model ? (
					<Text dimColor>
						{"  model: "}
						{mode.model}
					</Text>
				) : null}
				<Box marginTop={1}>
					<Text bold>{prompt.title}</Text>
					<Text dimColor>{`  — ${prompt.hint}`}</Text>
				</Box>
				<Box>
					<Text color="cyan">{"> "}</Text>
					<Text>{shown}</Text>
					<Text color="magenta">▎</Text>
				</Box>
				<Box marginTop={1}>
					<Text dimColor>Enter to continue · Esc to go back</Text>
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
