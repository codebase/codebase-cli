import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { rebuildMemoryIndex } from "./index-file.js";
import type { MemoryStore } from "./store.js";
import { type MemoryRecord, type MemoryType, parseMemoryType } from "./types.js";

/**
 * Background memory extraction. After enough new turns accumulate, a
 * cheap-model pass mines the transcript for durable, non-obvious facts
 * (who the user is, rules they gave, project context) and persists them
 * the way save_memory would — so the next session starts already knowing
 * them. Runs fire-and-forget off the turn-settle event; the env toggle
 * CODEBASE_NO_AUTO_MEMORY=1 disables it.
 */

/** Minimal slice of GlueClient the extractor needs — keeps it unit-testable. */
export interface ExtractorModel {
	fast(prompt: string, system?: string, signal?: AbortSignal): Promise<string>;
}

export interface MemoryExtractorOptions {
	store: MemoryStore;
	model: ExtractorModel;
	/** New messages required since the last pass before another runs. Default 12. */
	threshold?: number;
	/** Disable entirely (CODEBASE_NO_AUTO_MEMORY=1). Default false. */
	disabled?: boolean;
	/** High-water mark to start from — set to a resumed transcript's length. */
	startAt?: number;
}

const DEFAULT_THRESHOLD = 12;

const SYSTEM_PROMPT = `You extract durable memories from a coding-session transcript so a future session starts with the right context. Output is consumed by a program, not a human.

Save ONLY facts that are non-obvious AND useful across sessions, using this taxonomy:
- user: stable facts about the user (role, expertise, hard preferences).
- feedback: a rule the user gave you ("always X", "never Y"). Include the WHY.
- project: durable context about the work (goals, decisions, constraints, blockers). Convert relative dates to absolute.
- reference: pointers to external systems (tickets, dashboards, URLs).

Do NOT save: anything derivable from the code, file paths, git history, transient conversation state, or facts already in the existing index below. When in doubt, omit — a wrong or noisy memory is worse than a missing one.

Respond with a JSON array (and nothing else) of objects:
[{"type":"user|feedback|project|reference","name":"short title","description":"one line: when this applies","body":"the fact, with WHY for feedback/project"}]
Return [] if nothing is worth saving.`;

export class MemoryExtractor {
	private readonly store: MemoryStore;
	private readonly model: ExtractorModel;
	private readonly threshold: number;
	private readonly disabled: boolean;
	private highWater: number;
	private running = false;

	constructor(opts: MemoryExtractorOptions) {
		this.store = opts.store;
		this.model = opts.model;
		this.threshold = opts.threshold ?? DEFAULT_THRESHOLD;
		this.disabled = opts.disabled ?? false;
		this.highWater = opts.startAt ?? 0;
	}

	/**
	 * Consider the current transcript. Runs an extraction pass only when
	 * enough new messages have accumulated and one isn't already in flight.
	 * Returns the records saved this pass (empty when it didn't run or found
	 * nothing). Never throws — extraction is best-effort.
	 */
	async maybeExtract(messages: AgentMessage[], signal?: AbortSignal): Promise<MemoryRecord[]> {
		if (this.disabled || this.running) return [];
		if (messages.length - this.highWater < this.threshold) return [];
		this.running = true;
		const slice = messages.slice(this.highWater);
		// Advance the mark up front so a slow pass doesn't double-cover the
		// same messages if another turn settles before this one returns.
		this.highWater = messages.length;
		try {
			return await this.run(slice, signal);
		} catch {
			return [];
		} finally {
			this.running = false;
		}
	}

	private async run(slice: AgentMessage[], signal?: AbortSignal): Promise<MemoryRecord[]> {
		const transcript = renderTranscript(slice);
		if (!transcript.trim()) return [];
		const index = this.store.index().trim() || "(none yet)";
		const prompt = `Existing memory index (do not duplicate these):\n${index}\n\n--- Session transcript ---\n${transcript}`;
		const reply = await this.model.fast(prompt, SYSTEM_PROMPT, signal);
		const proposed = parseProposals(reply);
		if (proposed.length === 0) return [];

		const existingSlugs = new Set(
			this.store.list().map((r) => r.filename.replace(/\.md$/, "").replace(/-[a-z0-9]+$/, "")),
		);
		const saved: MemoryRecord[] = [];
		for (const p of proposed) {
			const slug = slugify(p.name);
			if (existingSlugs.has(slug)) continue; // already captured under this subject
			existingSlugs.add(slug);
			saved.push(
				this.store.save({
					filename: `${slug}-${stamp()}.md`,
					name: clip(p.name, 100),
					description: clip(p.description, 200),
					type: p.type,
					body: p.body.trim(),
				}),
			);
		}
		if (saved.length > 0) rebuildMemoryIndex(this.store);
		return saved;
	}
}

interface Proposal {
	type: MemoryType;
	name: string;
	description: string;
	body: string;
}

/** Pull the JSON array out of a model reply, tolerating prose or fences around it. */
export function parseProposals(reply: string): Proposal[] {
	const start = reply.indexOf("[");
	const end = reply.lastIndexOf("]");
	if (start === -1 || end <= start) return [];
	let arr: unknown;
	try {
		arr = JSON.parse(reply.slice(start, end + 1));
	} catch {
		return [];
	}
	if (!Array.isArray(arr)) return [];
	const out: Proposal[] = [];
	for (const item of arr) {
		if (!item || typeof item !== "object") continue;
		const o = item as Record<string, unknown>;
		const type = typeof o.type === "string" ? parseMemoryType(o.type) : null;
		const name = typeof o.name === "string" ? o.name.trim() : "";
		const description = typeof o.description === "string" ? o.description.trim() : "";
		const body = typeof o.body === "string" ? o.body.trim() : "";
		if (!type || !name || !body) continue;
		out.push({ type, name, description: description || name, body });
	}
	return out;
}

/** Flatten user/assistant text into a compact transcript; tool noise is dropped. */
function renderTranscript(messages: AgentMessage[]): string {
	const lines: string[] = [];
	for (const m of messages) {
		if (m.role !== "user" && m.role !== "assistant") continue;
		const text = messageText(m).trim();
		if (!text) continue;
		// Strip injected reminders so the model doesn't mine the harness's own scaffolding.
		const clean = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
		if (clean) lines.push(`${m.role.toUpperCase()}: ${clip(clean, 2000)}`);
	}
	return lines.join("\n\n");
}

function messageText(m: AgentMessage): string {
	if (typeof m.content === "string") return m.content;
	if (Array.isArray(m.content)) {
		return m.content
			.filter((b): b is { type: "text"; text: string } => (b as { type: string }).type === "text")
			.map((b) => b.text)
			.join(" ");
	}
	return "";
}

function slugify(s: string): string {
	return (
		s
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40) || "note"
	);
}

function clip(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function stamp(): string {
	return Date.now().toString(36);
}
