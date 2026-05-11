import * as vscode from "vscode";
import { RpcClient } from "./rpcClient.js";

const EXTENSION_NAME = "codebase";

let client: RpcClient | null = null;
let panelProvider: ChatPanelProvider | null = null;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const output = vscode.window.createOutputChannel("Codebase");
	context.subscriptions.push(output);

	panelProvider = new ChatPanelProvider(context, output);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider("codebase.chat", panelProvider, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("codebase.ask", async () => {
			await vscode.commands.executeCommand("codebase.chat.focus");
			panelProvider?.focusInput();
		}),
		vscode.commands.registerCommand("codebase.abort", async () => {
			if (!client?.isReady) return;
			await client.abort().catch((e) => output.appendLine(`abort failed: ${e}`));
		}),
		vscode.commands.registerCommand("codebase.restart", async () => {
			panelProvider?.restart();
		}),
	);
}

export function deactivate(): void {
	client?.dispose();
	client = null;
}

// ──────────────────────────────────────────────────────────────────────

class ChatPanelProvider implements vscode.WebviewViewProvider {
	private view: vscode.WebviewView | null = null;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly output: vscode.OutputChannel,
	) {}

	async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
		this.view = view;
		view.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
		};
		view.webview.html = this.renderHtml(view.webview);

		view.webview.onDidReceiveMessage(async (msg) => {
			switch (msg?.type) {
				case "ready":
					await this.ensureClient();
					this.postState();
					return;
				case "prompt":
					if (!client?.isReady) {
						this.toast("agent not ready yet");
						return;
					}
					try {
						await client.prompt(String(msg.message ?? ""));
					} catch (e) {
						this.post({ type: "error", message: e instanceof Error ? e.message : String(e) });
					}
					return;
				case "abort":
					if (client?.isReady) await client.abort().catch(() => undefined);
					return;
				case "permission":
					if (client?.isReady && msg.requestId && msg.choice) {
						await client.permissionRespond(msg.requestId, msg.choice).catch(() => undefined);
					}
					return;
			}
		});
	}

	focusInput(): void {
		this.post({ type: "focus" });
	}

	restart(): void {
		client?.dispose();
		client = null;
		this.post({ type: "restart" });
		void this.ensureClient();
	}

	private async ensureClient(): Promise<void> {
		if (client?.isReady) return;
		client?.dispose();

		const cfg = vscode.workspace.getConfiguration(EXTENSION_NAME);
		const binaryPath = cfg.get<string>("binaryPath", "codebase");
		const resume = cfg.get<boolean>("resume", true);
		const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

		const newClient = new RpcClient({ binaryPath, cwd, resume });
		client = newClient;

		newClient.on("event", (event) => this.post({ type: "agent_event", event }));
		newClient.on("stderr", (chunk: string) => this.output.append(chunk));
		newClient.on("disconnect", () => this.post({ type: "disconnect" }));
		newClient.on("error", (err: Error) => this.output.appendLine(`error: ${err.message}`));

		try {
			await newClient.start();
			await newClient.initialize({
				name: "codebase-vscode",
				version: this.context.extension.packageJSON.version ?? "0.0.0",
				title: "Codebase VS Code Extension",
			});
			this.post({ type: "ready" });
			this.postState();
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			this.output.appendLine(`failed to start codebase app-server: ${msg}`);
			this.post({
				type: "fatal",
				message: `Could not start ${binaryPath}: ${msg}. Make sure codebase-cli is installed (npm install -g codebase-cli) and configured (codebase auth login or set an API-key env var).`,
			});
		}
	}

	private async postState(): Promise<void> {
		if (!client?.isReady) return;
		try {
			const state = await client.getState();
			this.post({ type: "state", state });
		} catch {
			// best effort
		}
	}

	private post(message: unknown): void {
		void this.view?.webview.postMessage(message);
	}

	private toast(msg: string): void {
		void vscode.window.showInformationMessage(`Codebase: ${msg}`);
	}

	private renderHtml(webview: vscode.Webview): string {
		const mediaUri = (file: string) =>
			webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", file));
		const nonce = Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
		const csp = [
			"default-src 'none'",
			`style-src ${webview.cspSource} 'unsafe-inline'`,
			`script-src 'nonce-${nonce}'`,
			`font-src ${webview.cspSource}`,
		].join("; ");

		return /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<link rel="stylesheet" href="${mediaUri("main.css")}" />
<title>Codebase</title>
</head>
<body>
<div id="header">
	<span id="status">starting…</span>
	<span id="model"></span>
</div>
<div id="transcript"></div>
<div id="permission" hidden></div>
<form id="composer">
	<textarea id="input" rows="3" placeholder="Ask codebase…"></textarea>
	<div id="composer-row">
		<button type="button" id="abort" disabled>Abort</button>
		<button type="submit" id="send">Send</button>
	</div>
</form>
<script nonce="${nonce}" src="${mediaUri("main.js")}"></script>
</body>
</html>`;
	}
}
