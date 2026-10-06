export interface BillingReceipt {
	creditsCharged: number | null;
	usageEstimated: boolean;
	model: string;
}

export interface BillingSummary {
	creditsCharged: number;
	requests: number;
	unconfirmed: number;
	estimated: number;
	models: string[];
}

export function parseBillingReceipt(value: unknown, model: string): BillingReceipt | undefined {
	if (!value || typeof value !== "object") return undefined;
	const row = value as Record<string, unknown>;
	if (typeof row.usage_estimated !== "boolean") return undefined;
	const credits = row.credits_charged;
	if (credits !== null && (typeof credits !== "number" || !Number.isSafeInteger(credits) || credits < 0)) {
		return undefined;
	}
	return { creditsCharged: credits as number | null, usageEstimated: row.usage_estimated, model };
}

/** One entry per HTTP request, including sidecar and subagent calls. */
export class BillingLedger {
	private readonly entries: BillingReceipt[] = [];
	record(receipt: BillingReceipt): void {
		this.entries.push(receipt);
	}
	snapshot(): BillingSummary {
		return {
			creditsCharged: this.entries.reduce((sum, row) => sum + (row.creditsCharged ?? 0), 0),
			requests: this.entries.length,
			unconfirmed: this.entries.filter((row) => row.creditsCharged === null).length,
			estimated: this.entries.filter((row) => row.usageEstimated).length,
			models: [...new Set(this.entries.map((row) => row.model))],
		};
	}
}

export function formatBillingSummary(summary: BillingSummary): string {
	if (summary.requests === 0) return "No confirmed charges yet";
	const unknown = summary.unconfirmed ? ` + ${summary.unconfirmed} unconfirmed` : "";
	return `${summary.creditsCharged.toLocaleString()} credits charged${unknown}`;
}
