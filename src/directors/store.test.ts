import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	autonomyLine,
	buildDirectorAddendum,
	DirectorStore,
	demote,
	directorFromAnswers,
	permissionConfigFor,
	promote,
	slugify,
	trustOp,
} from "./store.js";
import type { Director } from "./types.js";

describe("pure helpers", () => {
	it("slugify strips 'Director of' and normalizes", () => {
		expect(slugify("Director of Marketing")).toBe("marketing");
		expect(slugify("Head of Growth!!")).toBe("head-of-growth");
		expect(slugify("")).toBe("director");
	});

	it("a new hire always starts cautious with no trusts", () => {
		const d = directorFromAnswers({ title: "Director of Marketing", mandate: "own the funnel" });
		expect(d).toMatchObject({ slug: "marketing", autonomy: "cautious", trusts: [] });
		expect(d.handbook).toContain("Context");
	});

	it("promote/demote clamp at the ends", () => {
		expect(promote("cautious")).toBe("balanced");
		expect(promote("balanced")).toBe("autonomous");
		expect(promote("autonomous")).toBe("autonomous");
		expect(demote("autonomous")).toBe("balanced");
		expect(demote("cautious")).toBe("cautious");
	});

	it("trustOp dedupes", () => {
		const d = directorFromAnswers({ title: "x", mandate: "y" });
		const a = trustOp(d, "shell:git push");
		const b = trustOp(a, "shell:git push");
		expect(a.trusts).toEqual(["shell:git push"]);
		expect(b).toBe(a); // unchanged reference when already present
	});

	it("permissionConfigFor gates cautious, auto-approves the rest", () => {
		const base = directorFromAnswers({ title: "x", mandate: "y" });
		expect(permissionConfigFor(base).autoApprove).toBe(false);
		expect(permissionConfigFor({ ...base, autonomy: "balanced" }).autoApprove).toBe(true);
		expect(permissionConfigFor({ ...base, autonomy: "autonomous", trusts: ["shell:git push"] })).toEqual({
			autoApprove: true,
			allowPatterns: ["shell:git push"],
		});
	});

	it("the prompt addendum frames escalation, not 'never hesitate'", () => {
		const d: Director = {
			slug: "m",
			name: "Director of Marketing",
			mandate: "the funnel",
			autonomy: "balanced",
			trusts: [],
			handbook: "Be brief.",
		};
		const text = buildDirectorAddendum(d);
		expect(text).toContain("Director of Marketing");
		expect(text).toContain("the funnel");
		expect(text).toContain("Be brief.");
		expect(text).toMatch(/surface|escalat|ask/i);
		expect(text).not.toMatch(/never need to hesitate/i);
	});

	it("autonomyLine reflects the lifecycle stage", () => {
		const base = directorFromAnswers({ title: "x", mandate: "y" });
		expect(autonomyLine(base)).toMatch(/training/i);
		expect(autonomyLine({ ...base, autonomy: "balanced" })).toMatch(/graduated/i);
		expect(autonomyLine({ ...base, autonomy: "autonomous", trusts: ["a"] })).toMatch(/trusted one/i);
	});
});

describe("DirectorStore", () => {
	let dir: string;
	let store: DirectorStore;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "directors-"));
		store = new DirectorStore({ baseDir: dir });
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("round-trips a director through markdown", () => {
		const d = trustOp(
			{ ...directorFromAnswers({ title: "Director of Marketing", mandate: "the funnel" }), autonomy: "autonomous" },
			"shell:git push origin marketing*",
		);
		store.save(d);
		const loaded = store.load("marketing");
		expect(loaded).toMatchObject({
			slug: "marketing",
			name: "Director of Marketing",
			mandate: "the funnel",
			autonomy: "autonomous",
			trusts: ["shell:git push origin marketing*"],
		});
	});

	it("lists sorted, and remove deletes", () => {
		store.save(directorFromAnswers({ title: "Director of Sales", mandate: "s" }));
		store.save(directorFromAnswers({ title: "Director of Marketing", mandate: "m" }));
		expect(store.list().map((d) => d.slug)).toEqual(["marketing", "sales"]);
		expect(store.remove("sales")).toBe(true);
		expect(store.remove("sales")).toBe(false);
		expect(store.list().map((d) => d.slug)).toEqual(["marketing"]);
	});

	it("trust() persists an earned op", () => {
		store.save(directorFromAnswers({ title: "x", mandate: "y" }));
		const updated = store.trust("x", "shell:git push");
		expect(updated?.trusts).toEqual(["shell:git push"]);
		expect(store.load("x")?.trusts).toEqual(["shell:git push"]);
		expect(store.trust("nope", "p")).toBeNull();
	});
});
