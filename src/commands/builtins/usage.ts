import { CredentialsStore } from "../../auth/credentials.js";
import { ensureFreshCredentials } from "../../auth/ensure-fresh.js";
import type { Command } from "../types.js";

const API_BASE = (process.env.CODEBASE_AUTH_BASE_URL ?? "https://codebase.design").replace(/\/+$/, "");

interface Balance {
	creditsRemaining?: number;
	anyBuildsRemaining?: number;
	cheapBuildsRemaining?: number;
	monthlyCredits?: number;
	monthly_credits?: number;
	periodEnd?: number | string;
	plan?: { monthlyCredits?: number; monthly_credits?: number; name?: string } | string;
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
	description: "Show metered credits and included Codebase turn allowances.",
	handler: async (_args, ctx) => {
		ctx.emit(await fetchUsageReport());
		return { handled: true };
	},
};

export async function fetchUsageReport(): Promise<string> {
	const store = new CredentialsStore();
	let creds = store.load();
	if (!creds) {
		return "Not signed in. Run `codebase auth login` first.";
	}
	if (creds.source !== "codebase") {
		return "Usage is only tracked for Codebase accounts (you're using a BYOK/manual key).";
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
			return "Session expired — run `codebase auth login` again.";
		}
		if (!res.ok) {
			return `Couldn't fetch usage (HTTP ${res.status}).`;
		}
		const b = (await res.json()) as Balance;
		const formatted = formatUsageBalance(b);
		const lines = [`Plan: ${formatted.planName}`, formatted.creditLine];
		if (formatted.pct != null) {
			lines.push(
				`${bar(formatted.pct)} ${formatted.pct}%${formatted.days != null ? `  ·  resets in ${formatted.days}d` : ""}`,
			);
		} else {
			lines.push("Monthly allowance was not returned yet; showing remaining credits only.");
		}
		if (typeof b.anyBuildsRemaining === "number" && b.anyBuildsRemaining >= 0) {
			lines.push(`Included web-build turns remaining: ${b.anyBuildsRemaining.toLocaleString()}`);
		}
		if (typeof b.cheapBuildsRemaining === "number" && b.cheapBuildsRemaining >= 0) {
			lines.push(`Included fast coding turns remaining: ${b.cheapBuildsRemaining.toLocaleString()}`);
		}
		return lines.join("\n");
	} catch (err) {
		return `Couldn't fetch usage: ${(err as Error).message}`;
	}
}

export function formatUsageBalance(b: Balance): {
	creditLine: string;
	days: number | null;
	pct: number | null;
	planName: string;
} {
	const plan = typeof b.plan === "object" && b.plan !== null ? b.plan : undefined;
	const allowance = firstNumber(
		plan?.monthlyCredits,
		plan?.monthly_credits,
		b.monthlyCredits,
		b.monthly_credits,
		b.planId?.toLowerCase() === "free" ? 50 : undefined,
	);
	const remaining = firstNumber(b.creditsRemaining) ?? 0;
	const days = daysUntil(b.periodEnd);
	const planName =
		b.planName ?? plan?.name ?? (typeof b.plan === "string" ? b.plan : undefined) ?? b.planId ?? "Codebase";
	if (!allowance || allowance <= 0) {
		return {
			creditLine: `Metered credits left: ${remaining.toLocaleString()}`,
			days,
			pct: null,
			planName,
		};
	}
	const used = Math.max(0, allowance - remaining);
	const pct = Math.max(0, Math.min(100, Math.round((used / allowance) * 100)));
	return {
		creditLine: `Metered credits: ${used.toLocaleString()} / ${allowance.toLocaleString()} used  ·  ${remaining.toLocaleString()} left`,
		days,
		pct,
		planName,
	};
}

function bar(pct: number): string {
	const width = 20;
	const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
	return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
}

function firstNumber(...values: Array<number | undefined>): number | undefined {
	for (const value of values) {
		if (typeof value === "number" && Number.isFinite(value)) return value;
	}
	return undefined;
}

function daysUntil(value: number | string | undefined): number | null {
	let ms: number;
	if (typeof value === "string") {
		ms = Date.parse(value);
	} else if (typeof value === "number") {
		ms = value < 10_000_000_000 ? value * 1000 : value;
	} else {
		return null;
	}
	if (!Number.isFinite(ms) || ms <= 0) return null;
	return Math.max(0, Math.ceil((ms - Date.now()) / 86_400_000));
}
