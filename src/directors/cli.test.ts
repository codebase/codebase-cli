import { describe, expect, it } from "vitest";
import { autonomyLine, directorFromAnswers } from "./cli.js";
import type { Director } from "./types.js";

describe("directorFromAnswers", () => {
	it("builds a director with a slug, empty trusts, and a starter handbook", () => {
		const d = directorFromAnswers({
			title: "Director of Marketing",
			mandate: "Own the launch",
			autonomy: "balanced",
		});
		expect(d.slug).toBe("marketing");
		expect(d.name).toBe("Director of Marketing");
		expect(d.mandate).toBe("Own the launch");
		expect(d.autonomy).toBe("balanced");
		expect(d.trusts).toEqual([]);
		expect(d.handbook).toContain("Context is king");
	});
});

describe("autonomyLine (the confidence line)", () => {
	const base: Director = { slug: "m", name: "M", mandate: "x", autonomy: "balanced", trusts: [], handbook: "" };

	it("balanced names the gated ops", () => {
		expect(autonomyLine(base)).toMatch(/push · deploy · delete · spend/);
	});

	it("cautious signals maximum oversight", () => {
		expect(autonomyLine({ ...base, autonomy: "cautious" })).toMatch(/before any change/);
	});

	it("autonomous reflects the trusted-set size", () => {
		expect(autonomyLine({ ...base, autonomy: "autonomous", trusts: ["shell:git push*"] })).toMatch(/1 trusted/);
		expect(autonomyLine({ ...base, autonomy: "autonomous" })).toMatch(/Runs freely/);
	});
});
