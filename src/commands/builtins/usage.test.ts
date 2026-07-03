import { describe, expect, it } from "vitest";
import { formatUsageBalance } from "./usage.js";

describe("formatUsageBalance", () => {
	it("uses top-level monthlyCredits from the v1 credits endpoint", () => {
		expect(
			formatUsageBalance({
				creditsRemaining: 750,
				monthlyCredits: 1000,
				plan: "pro",
			}),
		).toMatchObject({
			creditLine: "Credits: 250 / 1,000 used  ·  750 left",
			pct: 25,
			planName: "pro",
		});
	});

	it("also accepts nested plan monthlyCredits", () => {
		expect(
			formatUsageBalance({
				creditsRemaining: 10,
				plan: { name: "team", monthlyCredits: 40 },
			}),
		).toMatchObject({
			creditLine: "Credits: 30 / 40 used  ·  10 left",
			pct: 75,
			planName: "team",
		});
	});

	it("falls back to remaining credits when the allowance is absent", () => {
		expect(formatUsageBalance({ creditsRemaining: 125, planId: "free" })).toMatchObject({
			creditLine: "Credits left: 125",
			pct: null,
			planName: "free",
		});
	});

	it("handles null plan values from the live API", () => {
		expect(
			formatUsageBalance({
				creditsRemaining: 900,
				monthlyCredits: 1000,
				plan: null as never,
				planName: "pro",
			}),
		).toMatchObject({
			creditLine: "Credits: 100 / 1,000 used  ·  900 left",
			pct: 10,
			planName: "pro",
		});
	});
});
