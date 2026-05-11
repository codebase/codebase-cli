// @ts-check
// Webview script for the Codebase chat panel. Vanilla JS for size +
// CSP simplicity. Receives `agent_event` messages from the extension
// host and renders them into the transcript.

const vscode = acquireVsCodeApi();

const statusEl = /** @type {HTMLElement} */ (document.getElementById("status"));
const modelEl = /** @type {HTMLElement} */ (document.getElementById("model"));
const transcript = /** @type {HTMLElement} */ (document.getElementById("transcript"));
const permissionEl = /** @type {HTMLElement} */ (document.getElementById("permission"));
const composer = /** @type {HTMLFormElement} */ (document.getElementById("composer"));
const input = /** @type {HTMLTextAreaElement} */ (document.getElementById("input"));
const sendBtn = /** @type {HTMLButtonElement} */ (document.getElementById("send"));
const abortBtn = /** @type {HTMLButtonElement} */ (document.getElementById("abort"));
const attachBtn = /** @type {HTMLButtonElement} */ (document.getElementById("attach"));
const attachmentsEl = /** @type {HTMLElement} */ (document.getElementById("attachments"));

const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8 MB per image, conservative
const MAX_IMAGES = 8;
/** @type {{data: string, mimeType: string, name?: string}[]} */
const pendingImages = [];

let assistantBuffer = "";
/** @type {HTMLElement | null} */
let activeAssistantNode = null;
let lastUsage = null;

const STATUS_LABELS = {
	starting: "starting…",
	ready: "ready",
	thinking: "thinking…",
	streaming: "streaming",
	tool: "running tool…",
	idle: "ready",
	"awaiting-permission": "awaiting your approval",
	disconnected: "disconnected — restart from the Codebase: Restart command",
};

setStatus("starting");
vscode.postMessage({ type: "ready" });

window.addEventListener("message", (e) => {
	const msg = e.data;
	switch (msg?.type) {
		case "ready":
			setStatus("ready");
			return;
		case "restart":
			transcript.innerHTML = "";
			permissionEl.hidden = true;
			setStatus("starting");
			return;
		case "state":
			if (msg.state?.model)
				modelEl.textContent = `${msg.state.model.provider}/${msg.state.model.id}`;
			return;
		case "disconnect":
			setStatus("disconnected");
			sendBtn.disabled = true;
			return;
		case "fatal":
			renderError(msg.message);
			setStatus("disconnected");
			return;
		case "error":
			renderError(msg.message);
			return;
		case "focus":
			input.focus();
			return;
		case "images_picked":
			if (Array.isArray(msg.images)) {
				for (const img of msg.images) addImage(img.data, img.mimeType, img.name);
			}
			return;
		case "agent_event":
			handleAgentEvent(msg.event);
			return;
	}
});

composer.addEventListener("submit", (e) => {
	e.preventDefault();
	const message = input.value.trim();
	if (!message && pendingImages.length === 0) return;
	renderUser(message, pendingImages);
	const images = pendingImages.map((i) => ({ data: i.data, mimeType: i.mimeType }));
	pendingImages.length = 0;
	renderAttachments();
	input.value = "";
	autoresize();
	abortBtn.disabled = false;
	setStatus("thinking");
	vscode.postMessage({ type: "prompt", message, images: images.length > 0 ? images : undefined });
});

attachBtn.addEventListener("click", () => {
	vscode.postMessage({ type: "pick_images" });
});

input.addEventListener("paste", (e) => {
	if (!e.clipboardData) return;
	let consumed = false;
	for (const item of e.clipboardData.items) {
		if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
		const file = item.getAsFile();
		if (!file) continue;
		readFileAsImage(file);
		consumed = true;
	}
	if (consumed) e.preventDefault();
});

const dropTarget = document.body;
["dragenter", "dragover"].forEach((ev) => {
	dropTarget.addEventListener(ev, (e) => {
		const dt = /** @type {DragEvent} */ (e).dataTransfer;
		if (!dt) return;
		if ([...dt.items].some((i) => i.kind === "file" && i.type.startsWith("image/"))) {
			e.preventDefault();
			dropTarget.classList.add("dragover");
		}
	});
});
["dragleave", "drop"].forEach((ev) => {
	dropTarget.addEventListener(ev, () => dropTarget.classList.remove("dragover"));
});
dropTarget.addEventListener("drop", (e) => {
	const dt = e.dataTransfer;
	if (!dt) return;
	const files = [...dt.files].filter((f) => f.type.startsWith("image/"));
	if (files.length === 0) return;
	e.preventDefault();
	for (const f of files) readFileAsImage(f);
});

function readFileAsImage(file) {
	if (file.size > MAX_IMAGE_BYTES) {
		renderError(`image too large (${(file.size / 1024 / 1024).toFixed(1)} MB) — max ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);
		return;
	}
	const reader = new FileReader();
	reader.onload = () => {
		const result = reader.result;
		if (typeof result !== "string") return;
		const comma = result.indexOf(",");
		const base64 = comma >= 0 ? result.slice(comma + 1) : result;
		addImage(base64, file.type || "image/png", file.name);
	};
	reader.readAsDataURL(file);
}

function addImage(data, mimeType, name) {
	if (pendingImages.length >= MAX_IMAGES) {
		renderError(`max ${MAX_IMAGES} images per message`);
		return;
	}
	pendingImages.push({ data, mimeType, name });
	renderAttachments();
}

function renderAttachments() {
	if (pendingImages.length === 0) {
		attachmentsEl.hidden = true;
		attachmentsEl.innerHTML = "";
		return;
	}
	attachmentsEl.hidden = false;
	attachmentsEl.innerHTML = "";
	pendingImages.forEach((img, idx) => {
		const wrap = document.createElement("div");
		wrap.className = "thumb";
		const im = document.createElement("img");
		im.src = `data:${img.mimeType};base64,${img.data}`;
		im.alt = img.name || `image ${idx + 1}`;
		const rm = document.createElement("button");
		rm.type = "button";
		rm.textContent = "×";
		rm.title = "Remove";
		rm.addEventListener("click", () => {
			pendingImages.splice(idx, 1);
			renderAttachments();
		});
		wrap.appendChild(im);
		wrap.appendChild(rm);
		attachmentsEl.appendChild(wrap);
	});
}

abortBtn.addEventListener("click", () => {
	vscode.postMessage({ type: "abort" });
});

input.addEventListener("input", autoresize);
input.addEventListener("keydown", (e) => {
	if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
		e.preventDefault();
		composer.requestSubmit();
	}
});
autoresize();

// ── handlers ────────────────────────────────────────────────────────

function handleAgentEvent(event) {
	switch (event?.type) {
		case "agent_start":
		case "turn_start":
			setStatus("thinking");
			abortBtn.disabled = false;
			return;
		case "message_start":
			if (event.message?.role === "assistant") startAssistantBubble();
			return;
		case "message_update":
			if (event.message?.role === "assistant") streamAssistantText(extractText(event.message));
			return;
		case "message_end":
			if (event.message?.role === "assistant") finalizeAssistant(extractText(event.message));
			return;
		case "tool_execution_start":
			renderToolStart(event.toolName, event.args);
			setStatus("tool");
			return;
		case "tool_execution_end":
			renderToolEnd(event.toolName, event.isError);
			return;
		case "agent_end":
			setStatus("idle");
			abortBtn.disabled = true;
			activeAssistantNode = null;
			assistantBuffer = "";
			return;
		case "usage_update":
			lastUsage = event.usage;
			if (lastUsage) updateUsageBadge();
			return;
		case "permission_request":
			renderPermission(event.request);
			setStatus("awaiting-permission");
			return;
		case "permission_cleared":
			permissionEl.hidden = true;
			permissionEl.innerHTML = "";
			return;
		case "server_error":
			renderError(event.message);
			return;
	}
}

// ── rendering ───────────────────────────────────────────────────────

function renderUser(text, images) {
	const el = document.createElement("div");
	el.className = "msg msg-user";
	if (text) {
		const p = document.createElement("div");
		p.textContent = text;
		el.appendChild(p);
	}
	if (images && images.length > 0) {
		const row = document.createElement("div");
		row.className = "user-images";
		for (const img of images) {
			const im = document.createElement("img");
			im.src = `data:${img.mimeType};base64,${img.data}`;
			im.alt = img.name || "image";
			row.appendChild(im);
		}
		el.appendChild(row);
	}
	transcript.appendChild(el);
	scrollToBottom();
}

function startAssistantBubble() {
	activeAssistantNode = document.createElement("div");
	activeAssistantNode.className = "msg msg-assistant";
	transcript.appendChild(activeAssistantNode);
	assistantBuffer = "";
	scrollToBottom();
}

function streamAssistantText(text) {
	if (!text) return;
	if (!activeAssistantNode) startAssistantBubble();
	if (!activeAssistantNode) return;
	if (text.length > assistantBuffer.length) {
		const delta = text.slice(assistantBuffer.length);
		activeAssistantNode.append(document.createTextNode(delta));
		assistantBuffer = text;
		scrollToBottom();
	}
}

function finalizeAssistant(text) {
	if (text && activeAssistantNode && text.length > assistantBuffer.length) {
		const delta = text.slice(assistantBuffer.length);
		activeAssistantNode.append(document.createTextNode(delta));
	}
	activeAssistantNode = null;
	assistantBuffer = "";
}

function renderToolStart(name, args) {
	const el = document.createElement("div");
	el.className = "msg msg-tool";
	el.textContent = `▸ ${name}(${summarizeArgs(args)})`;
	transcript.appendChild(el);
	scrollToBottom();
}

function renderToolEnd(name, isError) {
	const last = transcript.lastElementChild;
	if (last && last.classList.contains("msg-tool") && last.textContent?.startsWith("▸ " + name)) {
		last.textContent = `${isError ? "✗" : "✓"} ${last.textContent.slice(2)}`;
		if (isError) last.classList.add("msg-tool-err");
	}
}

function renderPermission(req) {
	permissionEl.hidden = false;
	permissionEl.innerHTML = "";
	const summary = document.createElement("div");
	summary.className = "permission-summary";
	summary.textContent = `${req.tool}: ${req.summary}`;
	permissionEl.appendChild(summary);

	if (req.detail) {
		const detail = document.createElement("pre");
		detail.className = "permission-detail";
		detail.textContent = req.detail;
		permissionEl.appendChild(detail);
	}

	const row = document.createElement("div");
	row.className = "permission-row";
	for (const [label, choice] of [
		["Allow", "allow-once"],
		["Always for this tool", "trust-tool"],
		["Always all", "trust-all"],
		["Deny", "deny"],
	]) {
		const btn = document.createElement("button");
		btn.textContent = label;
		if (choice === "deny") btn.className = "danger";
		btn.addEventListener("click", () => {
			vscode.postMessage({ type: "permission", requestId: req.id, choice });
		});
		row.appendChild(btn);
	}
	permissionEl.appendChild(row);
}

function renderError(msg) {
	const el = document.createElement("div");
	el.className = "msg msg-error";
	el.textContent = msg;
	transcript.appendChild(el);
	scrollToBottom();
}

// ── utils ───────────────────────────────────────────────────────────

function extractText(message) {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	const parts = [];
	for (const block of message.content) {
		if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("");
}

function summarizeArgs(args) {
	if (!args || typeof args !== "object") return "";
	const a = args;
	if (a.command) return String(a.command).slice(0, 60);
	if (a.path) return String(a.path);
	if (a.file_path) return String(a.file_path);
	if (a.url) return String(a.url);
	if (a.query) return String(a.query);
	if (a.pattern) return String(a.pattern);
	const keys = Object.keys(a).slice(0, 2);
	return keys.map((k) => `${k}=${String(a[k]).slice(0, 30)}`).join(", ");
}

function setStatus(key) {
	statusEl.textContent = STATUS_LABELS[key] ?? key;
	statusEl.dataset.status = key;
}

function updateUsageBadge() {
	if (!lastUsage) return;
	const cost = lastUsage.cost?.total ?? 0;
	const total = lastUsage.totalTokens ?? 0;
	modelEl.title = `${total.toLocaleString()} tokens · $${cost.toFixed(4)}`;
}

function autoresize() {
	input.style.height = "auto";
	input.style.height = Math.min(input.scrollHeight, 200) + "px";
}

function scrollToBottom() {
	transcript.scrollTop = transcript.scrollHeight;
}
