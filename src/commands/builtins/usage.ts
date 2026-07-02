import { CredentialsStore } from "../../auth/credentials.js";
import { ensureFreshCredentials } from "../../auth/ensure-fresh.js";
import type { Command } from "../types.js";

const API_BASE = (process.env.CODEBASE_AUTH_BASE_URL ?? "https://codebase.design").replace(/\/+$/, "");

interface Balance {
	creditsRemaining?: number;
	anyBuildsRemaining?: number;
	periodEnd?: number;
	plan?: { monthlyCredits?: number };
	planId?: string;
	planName?: string;
}

/**
 * `/usage` — show the signed-in user's Codebase plan usage (credits used vs
 * allowance, % and reset date). Reads GET /api/v1/credits/balance with the
 * OAuth access token; the token's `credits` scope is accepted server-side.
 * (Distinct from `/cost`, which reports this session's token spend.)
 */
export const usage: Command = {
	name: "usage",
	description: "Show your Codebase plan usage — credits used, remaining, and reset date.",
	handler: async (_args, ctx) => {
		const store = new CredentialsStore();
		let creds = store.load();
		if (!creds) {
			ctx.emit("Not signed in. Run `codebase auth login` first.");
			return { handled: true };
		}
		if (creds.source !== "codebase") {
			ctx.emit("Usage is only tracked for Codebase accounts (you're using a BYOK/manual key).");
			return { handled: true };
		}
		try {
			await ensureFreshCredentials();
			creds = store.load() ?? creds;
		} catch {
			// fall through with the token we already have
		}

		try {
			const res = await fetch(`${API_BASE}/api/v1/credits/balance`, {
				headers: { Authorization: `Bearer ${creds.accessToken}` },
			});
			if (res.status === 401) {
				ctx.emit("Session expired — run `codebase auth login` again.");
				return { handled: true };
			}
			if (!res.ok) {
				ctx.emit(`Couldn't fetch usage (HTTP ${res.status}).`);
				return { handled: true };
			}
			const b = (await res.json()) as Balance;
			const allowance = b.plan?.monthlyCredits ?? 0;
			const remaining = b.creditsRemaining ?? 0;
			const used = Math.max(0, allowance - remaining);
			const pct = allowance > 0 ? Math.round((used / allowance) * 100) : 0;
			const days = b.periodEnd ? Math.max(0, Math.ceil((b.periodEnd - Date.now()) / 86_400_000)) : null;
			const planName = b.planName ?? b.planId ?? "—";

			const lines = [
				`Plan: ${planName}`,
				`Credits: ${used.toLocaleString()} / ${allowance.toLocaleString()} used  ·  ${remaining.toLocaleString()} left`,
				`${bar(pct)} ${pct}%${days != null ? `  ·  resets in ${days}d` : ""}`,
			];
			if (typeof b.anyBuildsRemaining === "number" && b.anyBuildsRemaining >= 0) {
				lines.push(`Build turns remaining: ${b.anyBuildsRemaining.toLocaleString()}`);
			}
			ctx.emit(lines.join("\n"));
		} catch (err) {
			ctx.emit(`Couldn't fetch usage: ${(err as Error).message}`);
		}
		return { handled: true };
	},
};

function bar(pct: number): string {
	const width = 20;
	const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
	return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
}
