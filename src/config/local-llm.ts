/**
 * Best-effort discovery of OpenAI-compatible LLM servers on localhost.
 * Probes the well-known ports of the common local runtimes and asks each
 * responder for its model list, enriching with context length where the
 * server exposes it:
 *
 *   LM Studio  :1234   — /api/v0/models reports max_context_length
 *   Ollama     :11434  — /api/show reports <arch>.context_length
 *   vLLM       :8000   — /v1/models entries carry max_model_len
 *   llama.cpp  :8080   — /v1/models entries carry meta.n_ctx_train
 *   tgw        :5000   — text-generation-webui, list only
 *
 * Everything is fail-soft: a port that doesn't answer within the probe
 * timeout, or answers with something that isn't a model list, is simply
 * skipped. Used by the first-run wizard so picking a local model is one
 * keystroke instead of typing a URL + model id by hand.
 */

export interface DiscoveredModel {
	id: string;
	contextWindow?: number;
}

export interface DiscoveredServer {
	label: string;
	baseUrl: string;
	models: DiscoveredModel[];
}

interface Candidate {
	label: string;
	port: number;
}

const CANDIDATES: readonly Candidate[] = [
	{ label: "LM Studio", port: 1234 },
	{ label: "Ollama", port: 11434 },
	{ label: "vLLM", port: 8000 },
	{ label: "llama.cpp", port: 8080 },
	{ label: "text-generation-webui", port: 5000 },
];

export const SCAN_PORTS: readonly number[] = CANDIDATES.map((c) => c.port);

const PROBE_TIMEOUT_MS = 800;
/** Per-model /api/show lookups are capped so a huge Ollama library doesn't stall the wizard. */
const MAX_ENRICH_LOOKUPS = 6;

export async function scanLocalEndpoints(fetchImpl: typeof fetch = fetch): Promise<DiscoveredServer[]> {
	const probed = await Promise.all(CANDIDATES.map((c) => probe(c, fetchImpl)));
	return probed.filter((s): s is DiscoveredServer => s !== null && s.models.length > 0);
}

async function probe(candidate: Candidate, fetchImpl: typeof fetch): Promise<DiscoveredServer | null> {
	const origin = `http://127.0.0.1:${candidate.port}`;
	const listing = await getJson(`${origin}/v1/models`, fetchImpl);
	const data = (listing as { data?: unknown[] } | null)?.data;
	if (!Array.isArray(data)) return null;

	let models: DiscoveredModel[] = [];
	for (const entry of data) {
		const m = entry as Record<string, unknown>;
		if (typeof m?.id !== "string" || !m.id) continue;
		// Embedding models show up in these listings too; they can't chat.
		if (/embed/i.test(m.id)) continue;
		models.push({
			id: m.id,
			contextWindow:
				numberOrUndef(m.max_model_len) ?? // vLLM
				numberOrUndef((m.meta as Record<string, unknown> | undefined)?.n_ctx_train), // llama.cpp
		});
	}

	if (candidate.label === "LM Studio") models = await enrichLmStudio(origin, models, fetchImpl);
	if (candidate.label === "Ollama") models = await enrichOllama(origin, models, fetchImpl);

	return { label: candidate.label, baseUrl: `${origin}/v1`, models };
}

/** LM Studio's native API reports max_context_length per model; match by id. */
async function enrichLmStudio(
	origin: string,
	models: DiscoveredModel[],
	fetchImpl: typeof fetch,
): Promise<DiscoveredModel[]> {
	const listing = await getJson(`${origin}/api/v0/models`, fetchImpl);
	const data = (listing as { data?: unknown[] } | null)?.data;
	if (!Array.isArray(data)) return models;
	const byId = new Map<string, number>();
	for (const entry of data) {
		const m = entry as Record<string, unknown>;
		const ctx = numberOrUndef(m?.max_context_length);
		if (typeof m?.id === "string" && ctx) byId.set(m.id, ctx);
	}
	return models.map((m) => ({ ...m, contextWindow: m.contextWindow ?? byId.get(m.id) }));
}

/** Ollama reports <arch>.context_length via /api/show, one call per model. */
async function enrichOllama(
	origin: string,
	models: DiscoveredModel[],
	fetchImpl: typeof fetch,
): Promise<DiscoveredModel[]> {
	return Promise.all(
		models.map(async (m, i) => {
			if (m.contextWindow || i >= MAX_ENRICH_LOOKUPS) return m;
			const info = await postJson(`${origin}/api/show`, { model: m.id }, fetchImpl);
			const modelInfo = (info as { model_info?: Record<string, unknown> } | null)?.model_info;
			if (!modelInfo) return m;
			for (const [key, value] of Object.entries(modelInfo)) {
				if (key.endsWith(".context_length")) {
					const ctx = numberOrUndef(value);
					if (ctx) return { ...m, contextWindow: ctx };
				}
			}
			return m;
		}),
	);
}

async function getJson(url: string, fetchImpl: typeof fetch): Promise<unknown | null> {
	return requestJson(url, { method: "GET" }, fetchImpl);
}

async function postJson(url: string, body: unknown, fetchImpl: typeof fetch): Promise<unknown | null> {
	return requestJson(
		url,
		{ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
		fetchImpl,
	);
}

async function requestJson(url: string, init: RequestInit, fetchImpl: typeof fetch): Promise<unknown | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
	try {
		const res = await fetchImpl(url, { ...init, signal: controller.signal });
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

function numberOrUndef(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** "131072" → "128k" — compact context-length label for the picker rows. */
export function formatContextWindow(ctx: number | undefined): string | undefined {
	if (!ctx) return undefined;
	return ctx >= 1024 ? `${Math.round(ctx / 1024)}k ctx` : `${ctx} ctx`;
}
