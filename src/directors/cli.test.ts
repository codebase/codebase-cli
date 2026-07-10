import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ActivityLog } from "./activity.js";
import { runDirectorSubcommand } from "./cli.js";
import { DirectorStore } from "./store.js";

describe("runDirectorSubcommand", () => {
	let root: string;
	let store: DirectorStore;
	let out: string[];
	let err: string[];

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "dir-cli-"));
		store = new DirectorStore({ baseDir: join(root, "directors") });
		out = [];
		err = [];
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	function run(argv: string[]) {
		return runDirectorSubcommand(argv, {
			store,
			cwd: "/proj",
			dataRoot: root,
			out: (s) => out.push(s),
			err: (s) => err.push(s),
		});
	}

	it("prints help", async () => {
		expect(await run(["director", "--help"])).toBe(0);
		expect(out.join("")).toMatch(/usage: codebase director/);
		expect(err.join("")).toBe("");
	});

	it("hire with flags creates a cautious director", async () => {
		expect(await run(["director", "hire", "--title", "Director of Marketing", "--owns", "the funnel"])).toBe(0);
		expect(out.join("")).toMatch(/Hired Director of Marketing.*training/s);
		expect(store.load("marketing")).toMatchObject({ autonomy: "cautious", mandate: "the funnel" });
	});

	it("hire refuses a duplicate", async () => {
		await run(["director", "hire", "--title", "Marketing", "--owns", "x"]);
		expect(await run(["director", "hire", "--title", "Marketing", "--owns", "y"])).toBe(1);
		expect(err.join("")).toMatch(/already exists/);
	});

	it("list shows the empty state then the roster", async () => {
		expect(await run(["director", "list"])).toBe(0);
		expect(out.join("")).toMatch(/No directors yet/);
		out.length = 0;
		await run(["director", "hire", "--title", "Marketing", "--owns", "the funnel"]);
		await run(["directors"]); // plural alias → list
		expect(out.join("")).toMatch(/@marketing.*the funnel/s);
	});

	it("status shows the no-activity state, then the track record", async () => {
		await run(["director", "hire", "--title", "Marketing", "--owns", "x"]);
		out.length = 0;
		await run(["director", "status", "marketing"]);
		expect(out.join("")).toMatch(/No activity on this project yet/);

		// Seed an activity log for this project+slug and re-check.
		const log = new ActivityLog({ cwd: "/proj", slug: "marketing", dataRoot: root });
		log.append({
			kind: "approved",
			tool: "shell",
			summary: "push",
			rev: "irreversible",
			risk: "high",
			family: "git push",
			ts: 1,
		});
		log.append({
			kind: "denied",
			tool: "shell",
			summary: "push",
			rev: "irreversible",
			risk: "high",
			family: "git push",
			ts: 2,
		});
		out.length = 0;
		await run(["director", "status", "marketing"]);
		const text = out.join("");
		expect(text).toMatch(/Track record/);
		expect(text).toMatch(/git push\s+1\/2/);
		expect(text).toMatch(/blocks graduation/); // 1 irreversible denial
	});

	it("status on an unknown director errors", async () => {
		expect(await run(["director", "status", "ghost"])).toBe(1);
		expect(err.join("")).toMatch(/no director/);
	});

	it("fire removes a director", async () => {
		await run(["director", "hire", "--title", "Marketing", "--owns", "x"]);
		expect(await run(["director", "fire", "marketing"])).toBe(0);
		expect(store.load("marketing")).toBeNull();
		expect(await run(["director", "fire", "marketing"])).toBe(1);
	});

	it("rejects an unknown subcommand and a bad flag", async () => {
		expect(await run(["director", "frobnicate"])).toBe(2);
		expect(await run(["director", "hire", "--bogus", "x"])).toBe(2);
	});
});
