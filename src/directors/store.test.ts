import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildDirectorAddendum, DirectorStore, permissionConfigFor, slugify, trustOp } from "./store.js";
import type { Director } from "./types.js";

const sample: Director = {
	slug: "marketing",
	name: "Director of Marketing",
	mandate: "Own Codebase's launch and Discord growth",
	autonomy: "balanced",
	trusts: ["shell:git push origin marketing*"],
	handbook: "# Voice\nPunchy, no hype.",
};

describe("DirectorStore", () => {
	let dir: string;
	let store: DirectorStore;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "directors-"));
		store = new DirectorStore({ baseDir: dir });
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("round-trips a director through save/load", () => {
		store.save(sample);
		expect(store.load("marketing")).toEqual(sample);
	});

	it("lists saved directors", () => {
		store.save(sample);
		store.save({ ...sample, slug: "grants", name: "Director of Grants" });
		expect(
			store
				.list()
				.map((d) => d.slug)
				.sort(),
		).toEqual(["grants", "marketing"]);
	});

	it("returns null for an unknown director", () => {
		expect(store.load("nobody")).toBeNull();
	});

	it("removes a director, idempotently", () => {
		store.save(sample);
		expect(store.remove("marketing")).toBe(true);
		expect(store.load("marketing")).toBeNull();
		expect(store.remove("marketing")).toBe(false);
	});

	it("defaults an invalid autonomy to balanced", () => {
		writeFileSync(join(dir, "x.md"), "---\nname: X\nautonomy: reckless\n---\nbody");
		expect(store.load("x")?.autonomy).toBe("balanced");
	});
});

describe("slugify", () => {
	it("strips 'Director of' and kebab-cases the rest", () => {
		expect(slugify("Director of Marketing")).toBe("marketing");
		expect(slugify("Growth & Ops")).toBe("growth-ops");
		expect(slugify("")).toBe("director");
	});
});

describe("permissionConfigFor", () => {
	it("cautious never auto-approves", () => {
		expect(permissionConfigFor({ ...sample, autonomy: "cautious" }).autoApprove).toBe(false);
	});

	it("balanced/autonomous auto-approve and carry the trusted allow-list", () => {
		const balanced = permissionConfigFor({ ...sample, autonomy: "balanced" });
		expect(balanced.autoApprove).toBe(true);
		expect(balanced.allowPatterns).toEqual(["shell:git push origin marketing*"]);
		expect(permissionConfigFor({ ...sample, autonomy: "autonomous" }).autoApprove).toBe(true);
	});
});

describe("buildDirectorAddendum", () => {
	it("names the director, states the mandate, and declares the gated boundary", () => {
		const out = buildDirectorAddendum(sample);
		expect(out).toContain("# You are the Director of Marketing");
		expect(out).toContain("Your mandate: Own Codebase's launch");
		expect(out).toContain("Punchy, no hype.");
		expect(out).toMatch(/irreversible operations .*are gated/);
	});
});

describe("trustOp + DirectorStore.trust (the capture step)", () => {
	it("trustOp adds a pattern, deduped, without mutating the input", () => {
		const d: Director = { ...sample, trusts: ["shell:git push*"] };
		expect(trustOp(d, "write_file").trusts).toEqual(["shell:git push*", "write_file"]);
		expect(trustOp(d, "shell:git push*").trusts).toEqual(["shell:git push*"]); // dedup → unchanged
		expect(d.trusts).toEqual(["shell:git push*"]); // original untouched
	});

	it("trust() persists across loads and accumulates", () => {
		const dir = mkdtempSync(join(tmpdir(), "directors-trust-"));
		const store = new DirectorStore({ baseDir: dir });
		store.save({ ...sample, trusts: [] });
		store.trust("marketing", "write_file");
		store.trust("marketing", "shell:git push origin marketing*");
		expect(store.load("marketing")?.trusts).toEqual(["write_file", "shell:git push origin marketing*"]);
		expect(store.trust("ghost", "x")).toBeNull();
		rmSync(dir, { recursive: true, force: true });
	});
});
