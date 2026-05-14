import type { Command } from "../types.js";

export const cost: Command = {
	name: "cost",
	description: "Detailed token + cost breakdown for the current session, including cache hit rate.",
	handler: (_args, ctx) => {
		const { state, bundle } = ctx;
		const u = state.usage;
		const turns = state.messages.filter((m) => m.role === "assistant").length;
		const promptTokens = u.input + u.cacheRead;
		const hitRate = promptTokens > 0 ? `${((u.cacheRead / promptTokens) * 100).toFixed(0)}%` : "—";
		const turnAvg = turns > 0 ? u.cost.total / turns : 0;
		const proxyNote = bundle.source === "proxy" ? " (proxied via codebase.foundation)" : "";

		const lines = [
			`Session cost: $${u.cost.total.toFixed(4)}${proxyNote}`,
			"",
			"Tokens:",
			`  Input         ${padNum(u.input, 8)} ($${u.cost.input.toFixed(4)})`,
			`  Output        ${padNum(u.output, 8)} ($${u.cost.output.toFixed(4)})`,
			`  Cache read    ${padNum(u.cacheRead, 8)} ($${u.cost.cacheRead.toFixed(4)})  ${hitRate} hit rate`,
			`  Cache write   ${padNum(u.cacheWrite, 8)} ($${u.cost.cacheWrite.toFixed(4)})`,
			"",
			turns > 0
				? `Turn average: $${turnAvg.toFixed(4)} (${turns} turn${turns === 1 ? "" : "s"})`
				: "No assistant turns yet.",
		];
		ctx.emit(lines.join("\n"));
		return { handled: true };
	},
};

function padNum(n: number, width: number): string {
	return n.toLocaleString().padStart(width, " ");
}
