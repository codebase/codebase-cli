import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchUsageReport, formatUsageBalance } from "./usage.js";

let homeDir: string | undefined;

afterEach(() => {
	vi.unstubAllEnvs();
	if (homeDir) {
		rmSync(homeDir, { recursive: true, force: true });
		homeDir = undefined;
	}
});

function isolateHome() {
	homeDir = mkdtempSync(join(tmpdir(), "codebase-usage-home-"));
	vi.stubEnv("HOME", homeDir);
	return homeDir;
}

describe("formatUsageBalance", () => {
	it("uses top-level monthlyCredits from the v1 credits endpoint", () => {
		expect(
			formatUsageBalance({
				creditsRemaining: 750,
				monthlyCredits: 1000,
				plan: "pro",
			}),
		).toMatchObject({
			creditLine: "Metered credits: 250 / 1,000 used  ·  750 left",
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
			creditLine: "Metered credits: 30 / 40 used  ·  10 left",
			pct: 75,
			planName: "team",
		});
	});

	it("uses the known free allowance when the live endpoint omits it", () => {
		expect(formatUsageBalance({ creditsRemaining: 25, planId: "free" })).toMatchObject({
			creditLine: "Metered credits: 25 / 50 used  ·  25 left",
			pct: 50,
			planName: "free",
		});
	});

	it("accepts snake-case allowance fields", () => {
		expect(formatUsageBalance({ creditsRemaining: 30, monthly_credits: 50, planId: "free" })).toMatchObject({
			creditLine: "Metered credits: 20 / 50 used  ·  30 left",
			pct: 40,
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
			creditLine: "Metered credits: 100 / 1,000 used  ·  900 left",
			pct: 10,
			planName: "pro",
		});
	});
});

describe("fetchUsageReport", () => {
	it("prints the login hint when no Codebase session exists", async () => {
		isolateHome();

		await expect(fetchUsageReport()).resolves.toBe("Not signed in. Run `codebase auth login` first.");
	});
});
