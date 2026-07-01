import { describe, expect, it } from "vitest";
import { runProjectSubcommand } from "./cli.js";
import type { ProjectClient } from "./client.js";
import type { PlatformProject } from "./types.js";

function fakeClient(opts: { projects?: PlatformProject[]; pullPath?: string } = {}): ProjectClient {
	return {
		list: async () => opts.projects ?? [],
		pull: async () => ({ path: opts.pullPath ?? "/tmp/project.zip", bytes: 2048 }),
		hasCredentials: () => true,
	} as unknown as ProjectClient;
}

async function runProject(argv: string[], client: ProjectClient) {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const code = await runProjectSubcommand(argv, {
		client,
		stdout: (m) => stdout.push(m),
		stderr: (m) => stderr.push(m),
	});
	return { code, stdout, stderr };
}

describe("runProjectSubcommand", () => {
	it("prints help without making a project API call", async () => {
		const stdout: string[] = [];
		const stderr: string[] = [];
		const client = {
			list: () => {
				throw new Error("list should not run for help");
			},
		} as unknown as ProjectClient;

		const code = await runProjectSubcommand(["project", "--help"], {
			client,
			stdout: (m) => stdout.push(m),
			stderr: (m) => stderr.push(m),
		});

		expect(code).toBe(0);
		expect(stdout.join("\n")).toMatch(/usage: codebase project/);
		expect(stdout.join("\n")).toMatch(/codebase\.design/);
		expect(stderr).toEqual([]);
	});

	it("defaults project list to 25 entries and puts titled indexed projects first", async () => {
		const projects: PlatformProject[] = [
			{ id: "storage-a", source: "storage-only" },
			{ id: "indexed-untitled", source: "convex", createdAt: "2026-01-01T00:00:00Z" },
			{ id: "indexed-titled", title: "A real app", source: "convex", createdAt: "2026-01-02T00:00:00Z" },
			...Array.from({ length: 27 }, (_, i) => ({ id: `storage-${i}`, source: "storage-only" as const })),
		];

		const { code, stdout, stderr } = await runProject(["project", "list"], fakeClient({ projects }));

		expect(code).toBe(0);
		expect(stderr).toEqual([]);
		expect(stdout[0]).toContain("30 projects (showing 25");
		const body = stdout.join("\n");
		expect(body.indexOf("indexed-titled")).toBeLessThan(body.indexOf("indexed-untitled"));
		expect((body.match(/\bstorage-/g) ?? []).length).toBe(23);
	});

	it("supports --all and --limit for project list", async () => {
		const projects = Array.from({ length: 3 }, (_, i) => ({ id: `p${i}`, source: "storage-only" as const }));

		const all = await runProject(["project", "--all"], fakeClient({ projects }));
		expect(all.code).toBe(0);
		expect(all.stdout.join("\n")).toContain("p2");
		expect(all.stdout[0]).not.toContain("showing");

		const limited = await runProject(["project", "list", "--limit=1"], fakeClient({ projects }));
		expect(limited.code).toBe(0);
		expect(limited.stdout.join("\n")).toContain("p0");
		expect(limited.stdout.join("\n")).not.toContain("p1");
	});

	it("rejects invalid project list flags", async () => {
		const result = await runProject(["project", "list", "--limit", "0"], fakeClient());
		expect(result.code).toBe(2);
		expect(result.stderr.join("\n")).toMatch(/positive integer/);
	});

	it("prints a destination-aware unzip hint after pull", async () => {
		const result = await runProject(
			["project", "pull", "has/slash", "/tmp/Codebase Pulls/out.zip"],
			fakeClient({ pullPath: "/tmp/Codebase Pulls/out.zip" }),
		);
		expect(result.code).toBe(0);
		expect(result.stdout.join("\n")).toContain(
			"unzip -d '/tmp/Codebase Pulls/has_slash' '/tmp/Codebase Pulls/out.zip'",
		);
	});
});
