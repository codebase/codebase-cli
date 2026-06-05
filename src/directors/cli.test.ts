import { describe, expect, it } from "vitest";
import { autonomyLine, demote, directorFromAnswers, promote } from "./cli.js";
import type { Director } from "./types.js";

describe("directorFromAnswers", () => {
	it("starts every new hire in training, with empty trusts and a starter handbook", () => {
		const d = directorFromAnswers({ title: "Director of Marketing", mandate: "Own the launch" });
		expect(d.slug).toBe("marketing");
		expect(d.name).toBe("Director of Marketing");
		expect(d.mandate).toBe("Own the launch");
		expect(d.autonomy).toBe("cautious"); // training — autonomy is earned, not picked
		expect(d.trusts).toEqual([]);
		expect(d.handbook).toContain("Context is king");
	});
});

describe("promote / demote (the lifecycle ladder)", () => {
	it("promote moves up and clamps at autonomous", () => {
		expect(promote("cautious")).toBe("balanced");
		expect(promote("balanced")).toBe("autonomous");
		expect(promote("autonomous")).toBe("autonomous");
	});
	it("demote moves down and clamps at cautious", () => {
		expect(demote("autonomous")).toBe("balanced");
		expect(demote("balanced")).toBe("cautious");
		expect(demote("cautious")).toBe("cautious");
	});
});

describe("autonomyLine (the lifecycle line)", () => {
	const base: Director = { slug: "m", name: "M", mandate: "x", autonomy: "balanced", trusts: [], handbook: "" };

	it("training (cautious) tells you to shadow it", () => {
		expect(autonomyLine({ ...base, autonomy: "cautious" })).toMatch(/training|shadow/i);
	});
	it("graduated (balanced) names the gated ops", () => {
		expect(autonomyLine(base)).toMatch(/push · deploy · delete · spend/);
	});
	it("autonomous (unleashed) reflects the trusted-set size", () => {
		expect(autonomyLine({ ...base, autonomy: "autonomous", trusts: ["shell:git push*"] })).toMatch(/1 trusted/);
		expect(autonomyLine({ ...base, autonomy: "autonomous" })).toMatch(/Unleashed/);
	});
});
