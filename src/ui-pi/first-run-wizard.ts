import { type Component, Container, Input, SelectList, Text, type TUI } from "@earendil-works/pi-tui";
import { CredentialsStore } from "../auth/credentials.js";
import { type OAuthConfig, type PasteResult, runOAuthLogin } from "../auth/flow.js";
import { ansi, selectListTheme } from "./theme.js";

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

const MENU_ITEMS = [
	{
		value: "oauth",
		label: "Login to Codebase",
		description: "free credits · Codebase Auto model · curated skills",
	},
	{
		value: "byok",
		label: "Bring your own LLM key",
		description: "Anthropic / OpenAI / Groq key, or any OpenAI-compatible endpoint",
	},
	{ value: "quit", label: "Quit", description: "exit the wizard" },
];

const PROVIDER_ITEMS = PROVIDER_CHOICES.map((p) => ({
	value: p.id,
	label: p.label,
	description: p.hint,
}));

type WizardMode =
	| "menu"
	| "oauth-running"
	| "signed-in"
	| "byok-provider"
	| { kind: "byok-key"; provider: ProviderChoice }
	| { kind: "byok-compat"; step: CompatStep; url: string; model: string }
	| { kind: "error"; message: string };

interface FirstRunWizardOptions {
	tui: TUI;
	store?: CredentialsStore;
	authBase?: string;
	onDone: () => void;
	onQuit: () => void;
}

/**
 * First-run setup wizard. Ports ink FirstRunSetup.tsx to pi-tui:
 * three-way menu (OAuth login / BYOK / quit), an OAuth-running screen
 * that shows the sign-in URL while we wait for the callback, a BYOK
 * provider picker, a key-entry input, and an error screen that bounces
 * back to the menu.
 *
 * Lifecycle: caller constructs us with a TUI ref, adds us as a child
 * (or shows us as an overlay), and listens for onDone / onQuit. We
 * persist the credential ourselves and signal completion so the runtime
 * can re-attempt createAgent.
 */
export class FirstRunWizard extends Container {
	private readonly tui: TUI;
	private readonly store: CredentialsStore;
	private readonly authBase: string;
	private readonly onDone: () => void;
	private readonly onQuit: () => void;
	private mode: WizardMode = "menu";
	private manualUrl: { url: string; reason: string } | undefined;
	private cancelOAuth = false;
	private menuList: SelectList | undefined;
	private providerList: SelectList | undefined;
	private keyInput: Input | undefined;
	/** Paste-input box on the oauth-running screen. Lazily built when the URL arrives. */
	private pasteInput: Input | undefined;
	/** Callback handed back from flow.ts to validate + submit a pasted URL. */
	private submitPaste: ((input: string) => PasteResult) | undefined;
	/** Last paste error, rendered inline so the user knows what to fix. */
	private pasteError: string | undefined;

	constructor(opts: FirstRunWizardOptions) {
		super();
		this.tui = opts.tui;
		this.store = opts.store ?? new CredentialsStore();
		this.authBase = opts.authBase ?? DEFAULT_AUTH_BASE;
		this.onDone = opts.onDone;
		this.onQuit = opts.onQuit;
		this.renderMode();
	}

	/** Component to focus when the wizard mounts/refreshes. Runtime calls TUI.setFocus(this.getFocusTarget()). */
	getFocusTarget(): Component | undefined {
		if (this.mode === "menu") return this.menuList;
		if (this.mode === "byok-provider") return this.providerList;
		if (typeof this.mode === "object" && (this.mode.kind === "byok-key" || this.mode.kind === "byok-compat")) {
			return this.keyInput;
		}
		if (this.mode === "oauth-running" && this.pasteInput) return this.pasteInput;
		return undefined;
	}

	private handlePasteSubmit(text: string): void {
		if (!this.submitPaste) return;
		const result = this.submitPaste(text);
		if (result.ok) {
			// Flow will resolve and runOAuth() will swap to signed-in.
			this.pasteError = undefined;
			return;
		}
		this.pasteError = result.error;
		// Clear the input so the user can paste a fresh URL without first
		// having to manually delete the bad one.
		this.pasteInput?.setValue("");
		this.renderMode();
	}

	private renderMode(): void {
		this.clear();
		this.addChild(new Text(ansi.bold(ansi.cyan("codebase")), 1, 1));
		this.addChild(new Text(ansi.dim("AI coding agent · CLI"), 1, 0));
		this.addChild(
			new Text(
				ansi.dim("Pick how you want to power the agent. You can change this later via `codebase auth`."),
				1,
				1,
			),
		);

		if (this.mode === "menu") {
			this.menuList = new SelectList(MENU_ITEMS, 3, selectListTheme);
			this.menuList.onSelect = (item) => this.handleMenuPick(item.value);
			this.menuList.onCancel = () => this.onQuit();
			this.addChild(this.menuList);
			this.addChild(new Text(ansi.dim("↑↓ to move · Enter to select · Esc to quit"), 1, 1));
		} else if (this.mode === "oauth-running") {
			this.renderOAuthRunning();
		} else if (this.mode === "signed-in") {
			this.addChild(new Text(ansi.bold(ansi.green("✓ Signed in")), 1, 0));
			this.addChild(new Text(ansi.dim("Starting agent…"), 1, 1));
		} else if (this.mode === "byok-provider") {
			this.addChild(new Text(ansi.bold("Pick a provider:"), 1, 0));
			this.providerList = new SelectList(PROVIDER_ITEMS, Math.min(9, PROVIDER_ITEMS.length), selectListTheme);
			this.providerList.onSelect = (item) => this.handleProviderPick(item.value);
			this.providerList.onCancel = () => this.setMode("menu");
			this.addChild(this.providerList);
			this.addChild(new Text(ansi.dim("↑↓ Enter · Esc to go back"), 1, 1));
		} else if (typeof this.mode === "object" && this.mode.kind === "byok-key") {
			this.renderKeyEntry(this.mode.provider);
		} else if (typeof this.mode === "object" && this.mode.kind === "byok-compat") {
			this.renderCompatEntry(this.mode);
		} else if (typeof this.mode === "object" && this.mode.kind === "error") {
			this.renderError(this.mode.message);
		}

		this.invalidate();
		const focus = this.getFocusTarget();
		if (focus) this.tui.setFocus(focus);
	}

	private renderOAuthRunning(): void {
		if (this.manualUrl) {
			this.addChild(new Text(ansi.bold(ansi.yellow("Sign in to continue")), 1, 0));
			this.addChild(
				new Text(ansi.dim("Opening browser automatically. If it didn't open, copy the URL below:"), 1, 1),
			);
			// Bare URL on its own line with NO left padding so terminal
			// select-copy doesn't pick up indent spaces. The terminal may
			// still hard-wrap the URL across rows; cmd/triple-click most
			// modern terminals still grab the whole token, and selecting
			// across rows usually preserves the contiguous string.
			this.addChild(new Text(ansi.cyan(this.manualUrl.url), 0, 0));
			this.addChild(new Text(ansi.dim("Waiting for the browser to redirect back."), 1, 1));
			// Paste fallback. If the localhost redirect fails (remote SSH,
			// browser refusing to hit 127.0.0.1, etc.) the user's browser
			// still has the failed URL in its address bar — that URL
			// contains the code + state. They paste it here and we finish
			// the flow without the local listener.
			this.addChild(new Text(ansi.dim("Redirect failed? Paste the http://127.0.0.1/callback?... URL here:"), 1, 0));
			this.pasteInput = new Input();
			this.pasteInput.onSubmit = (text) => this.handlePasteSubmit(text);
			this.addChild(this.pasteInput);
			if (this.pasteError) {
				this.addChild(new Text(ansi.red(this.pasteError), 1, 0));
			}
			this.addChild(new Text(ansi.dim("(Ctrl-C to cancel)"), 1, 1));
		} else {
			this.addChild(new Text(`Opening ${ansi.cyan(this.authBase)} in your browser…`, 1, 0));
			this.addChild(
				new Text(ansi.dim("Complete sign-in in the browser tab. This window will continue automatically."), 1, 1),
			);
		}
	}

	private renderKeyEntry(provider: ProviderChoice): void {
		this.addChild(
			new Text(
				`${ansi.bold(`Paste your ${provider.label} API key`)}${provider.keyHint ? ansi.dim(` (${provider.keyHint})`) : ""}`,
				1,
				0,
			),
		);
		const input = new Input();
		// Hide the key as it's typed — Input doesn't have a masked mode, so
		// we hook setValue/getValue: pi-tui's Input doesn't expose a mask
		// API today, so we fall back to plain echo. Users will need to
		// trust their screen for the seconds it takes to paste.
		input.onSubmit = (value) => {
			const trimmed = value.trim();
			if (trimmed.length === 0) return;
			try {
				this.store.save({
					accessToken: trimmed,
					scopes: [],
					source: "byok",
					provider: provider.id,
				});
				this.onDone();
			} catch (err) {
				this.setMode({ kind: "error", message: err instanceof Error ? err.message : String(err) });
			}
		};
		input.onEscape = () => this.setMode("byok-provider");
		this.keyInput = input;
		this.addChild(input);
		this.addChild(
			new Text(ansi.dim("Stored at ~/.codebase/credentials.json (mode 0600). Enter to save, Esc to go back."), 1, 1),
		);
	}

	private renderCompatEntry(mode: { step: CompatStep; url: string; model: string }): void {
		const prompt = COMPAT_PROMPTS[mode.step];
		const stepNum = mode.step === "url" ? 1 : mode.step === "model" ? 2 : 3;
		this.addChild(new Text(`${ansi.bold("OpenAI-compatible endpoint")}${ansi.dim(` · step ${stepNum}/3`)}`, 1, 0));
		if (mode.url) this.addChild(new Text(ansi.dim(`  url: ${mode.url}`), 1, 0));
		if (mode.model) this.addChild(new Text(ansi.dim(`  model: ${mode.model}`), 1, 0));
		this.addChild(new Text(`${ansi.bold(prompt.title)}${ansi.dim(`  — ${prompt.hint}`)}`, 1, 1));
		const input = new Input();
		input.onSubmit = (value) => {
			const trimmed = value.trim();
			if (mode.step === "url") {
				if (!/^https?:\/\//.test(trimmed)) return;
				this.setMode({ kind: "byok-compat", step: "model", url: trimmed, model: mode.model });
			} else if (mode.step === "model") {
				if (trimmed.length === 0) return;
				this.setMode({ kind: "byok-compat", step: "key", url: mode.url, model: trimmed });
			} else {
				try {
					this.store.save({
						// Servers without auth still get a syntactically-valid
						// bearer; Ollama / LM Studio ignore it entirely.
						accessToken: trimmed.length > 0 ? trimmed : "none",
						scopes: [],
						source: "byok",
						provider: "openai-compat",
						baseUrl: mode.url.replace(/\/+$/, ""),
						model: mode.model,
					});
					this.onDone();
				} catch (err) {
					this.setMode({ kind: "error", message: err instanceof Error ? err.message : String(err) });
				}
			}
		};
		input.onEscape = () => {
			// Step back one field; from the first field, back to the picker.
			if (mode.step === "key")
				this.setMode({ kind: "byok-compat", step: "model", url: mode.url, model: mode.model });
			else if (mode.step === "model")
				this.setMode({ kind: "byok-compat", step: "url", url: mode.url, model: mode.model });
			else this.setMode("byok-provider");
		};
		this.keyInput = input;
		this.addChild(input);
		this.addChild(new Text(ansi.dim("Enter to continue · Esc to go back"), 1, 1));
	}

	private renderError(message: string): void {
		this.addChild(new Text(ansi.bold(ansi.red("That didn't work")), 1, 0));
		this.addChild(new Text(message, 1, 1));
		this.addChild(new Text(ansi.dim("Any key returns to the menu."), 1, 1));
		// Caller's runtime input listener catches the key and switches back.
		// We attach a one-shot listener via TUI's global input listener
		// because we want any key, not a focused-component event.
		const remove = this.tui.addInputListener(() => {
			remove();
			this.setMode("menu");
			return { consume: true };
		});
	}

	private handleMenuPick(value: string): void {
		if (value === "oauth") {
			this.setMode("oauth-running");
			void this.runOAuth();
		} else if (value === "byok") {
			this.setMode("byok-provider");
		} else {
			this.onQuit();
		}
	}

	private handleProviderPick(value: string): void {
		const provider = PROVIDER_CHOICES.find((p) => p.id === value);
		if (!provider) return;
		if (provider.id === "openai-compat") {
			this.setMode({ kind: "byok-compat", step: "url", url: "", model: "" });
		} else {
			this.setMode({ kind: "byok-key", provider });
		}
	}

	private async runOAuth(): Promise<void> {
		this.cancelOAuth = false;
		this.submitPaste = undefined;
		this.pasteError = undefined;
		try {
			const config = oauthConfigForBase(this.authBase);
			const creds = await runOAuthLogin(config, {
				onManualUrl: (url, reason) => {
					if (this.cancelOAuth) return;
					this.manualUrl = { url, reason };
					this.renderMode();
				},
				onPasteFallback: (submit) => {
					this.submitPaste = submit;
				},
			});
			if (this.cancelOAuth) return;
			this.store.save({
				accessToken: creds.accessToken,
				refreshToken: creds.refreshToken,
				expiresAt: creds.expiresAt,
				scopes: creds.scopes,
				userId: creds.userId,
				email: creds.email,
				source: "codebase",
			});
			// Flash a success screen so the user gets visible feedback
			// before the wizard tears down and the App mounts. Without
			// this, the moment between OAuth-callback and App-mount looks
			// like a hang — the browser tab says "Signed in" but the CLI
			// shows nothing until the agent boots and emits its first
			// event.
			this.setMode("signed-in");
			this.tui.requestRender();
			this.onDone();
		} catch (err) {
			if (this.cancelOAuth) return;
			this.setMode({ kind: "error", message: err instanceof Error ? err.message : String(err) });
		}
	}

	private setMode(mode: WizardMode): void {
		// Cancel any in-flight OAuth attempt when leaving its screen so a
		// late callback doesn't try to update a torn-down view.
		if (this.mode === "oauth-running" && mode !== "oauth-running") {
			this.cancelOAuth = true;
		}
		this.mode = mode;
		this.manualUrl = undefined;
		this.renderMode();
	}
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
