import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runProjectSubcommand } from "./cli.js";
import { type ProjectClient, ProjectClientError } from "./client.js";
import { BuildHandoffStore } from "./handoff.js";
import type {
	BuildCancelResponse,
	BuildPreviewResponse,
	BuildStartResponse,
	BuildStatusResponse,
	PlatformProject,
} from "./types.js";

function fakeClient(
	opts: {
		projects?: PlatformProject[];
		pullPath?: string;
		onStartBuild?: (input: { prompt: string; model?: string; scaffold?: string; projectId?: string }) => void;
		onGetBuildStatus?: (sessionId: string) => void;
		onEnsureBuildPreview?: (sessionId: string) => void;
		onCancelBuild?: (sessionId: string) => void;
		build?: BuildStartResponse;
		status?: BuildStatusResponse;
		preview?: BuildPreviewResponse;
		cancel?: BuildCancelResponse;
	} = {},
): ProjectClient {
	return {
		list: async () => opts.projects ?? [],
		pull: async () => ({ path: opts.pullPath ?? "/tmp/project.zip", bytes: 2048 }),
		hasCredentials: () => true,
		startBuild: async (input) => {
			opts.onStartBuild?.(input);
			return (
				opts.build ?? {
					sessionId: "sess-1",
					projectId: "proj-1",
					status: "building",
					continued: !!input.projectId,
					model: "codebase/d4f",
				}
			);
		},
		getBuildStatus: async (sessionId: string) => {
			opts.onGetBuildStatus?.(sessionId);
			return opts.status ?? { sessionId, status: "completed", projectId: "proj-1" };
		},
		ensureBuildPreview: async (sessionId: string) => {
			opts.onEnsureBuildPreview?.(sessionId);
			return opts.preview ?? { ok: true, previewPath: "/preview/proj-1" };
		},
		cancelBuild: async (sessionId: string) => {
			opts.onCancelBuild?.(sessionId);
			return opts.cancel ?? { sessionId, status: "cancelled", stopped: true };
		},
		absoluteUrl: (path: string) => `https://codebase.design${path.startsWith("/") ? path : `/${path}`}`,
	} as unknown as ProjectClient;
}

async function runProject(argv: string[], client: ProjectClient, handoffStore: BuildHandoffStore | null = null) {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const code = await runProjectSubcommand(argv, {
		client,
		stdout: (m) => stdout.push(m),
		stderr: (m) => stderr.push(m),
		sleep: async () => undefined,
		handoffStore,
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
			handoffStore: null,
		});

		expect(code).toBe(0);
		expect(stdout.join("\n")).toMatch(/usage: codebase project/);
		expect(stdout.join("\n")).toMatch(/codebase\.design/);
		expect(stderr).toEqual([]);
	});

	it("prints web-build alias in build help", async () => {
		const result = await runProject(["project", "build", "--help"], fakeClient());

		expect(result.code).toBe(0);
		expect(result.stdout.join("\n")).toContain("alias: codebase web-build");
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

	it("starts a web build with prompt and options", async () => {
		let input: { prompt: string; model?: string; scaffold?: string; projectId?: string } | undefined;

		const result = await runProject(
			[
				"project",
				"build",
				"--model",
				"codebase/d4f",
				"--scaffold",
				"scaffold-next",
				"--project",
				"proj-1",
				"Build",
				"a",
				"waitlist",
			],
			fakeClient({
				onStartBuild: (value) => {
					input = value;
				},
			}),
		);

		expect(result.code).toBe(0);
		expect(input).toEqual({
			prompt: "Build a waitlist",
			model: "codebase/d4f",
			scaffold: "scaffold-next",
			projectId: "proj-1",
		});
		expect(result.stdout.join("\n")).toContain("session: sess-1");
		expect(result.stdout.join("\n")).toContain("codebase project status sess-1");
	});

	it("cancels when the web API does not confirm requested project continuity", async () => {
		const cancelled: string[] = [];
		const client = fakeClient({
			build: { sessionId: "wrong-session", projectId: "wrong-project", status: "building" },
			onCancelBuild: (sessionId) => cancelled.push(sessionId),
		});

		const result = await runProject(
			["project", "build", "--project", "proj-1", "Fix", "the", "existing", "app"],
			client,
		);

		expect(result.code).toBe(1);
		expect(result.stderr.join("\n")).toContain("did not confirm continuation of project proj-1");
		expect(cancelled).toEqual(["wrong-session"]);
	});

	it("explains payment challenges from the web build endpoint", async () => {
		const client = {
			startBuild: async () => {
				throw new ProjectClientError("request failed: 402", 402);
			},
			hasCredentials: () => true,
		} as unknown as ProjectClient;

		const result = await runProject(["project", "build", "Build", "it"], client);

		expect(result.code).toBe(1);
		expect(result.stderr.join("\n")).toContain("payment challenge");
		expect(result.stderr.join("\n")).toContain("web build OAuth gate");
	});

	it("waits for a completed build and prints its preview URL", async () => {
		const result = await runProject(
			["project", "build", "--wait", "Build", "a", "demo"],
			fakeClient({
				status: {
					sessionId: "sess-1",
					status: "completed",
					projectId: "proj-1",
					filesCreated: ["index.html", "styles.css"],
				},
				preview: { ok: true, previewPath: "/preview/proj-1" },
			}),
		);

		expect(result.code).toBe(0);
		expect(result.stdout.join("\n")).toContain("files:   index.html, styles.css");
		expect(result.stdout.join("\n")).toContain("preview: https://codebase.design/preview/proj-1");
	});

	it("fails a terminal build and prints the server reason", async () => {
		const result = await runProject(
			["project", "build", "--wait", "Build", "a", "demo"],
			fakeClient({
				status: {
					sessionId: "sess-1",
					status: "failed",
					projectId: "proj-1",
					error: "active-project cap reached (1)",
				},
			}),
		);

		expect(result.code).toBe(1);
		expect(result.stdout.join("\n")).toContain("build sess-1: failed");
		expect(result.stdout.join("\n")).toContain("error:   active-project cap reached (1)");
	});

	it("streams deduplicated file and phase progress while waiting", async () => {
		let calls = 0;
		const statuses: BuildStatusResponse[] = [
			{
				sessionId: "sess-1",
				status: "building",
				filesCreated: ["index.html", "index.html"],
				timeline: [{ phase: "scaffold-copy", durationMs: 1250, success: true }],
			},
			{
				sessionId: "sess-1",
				status: "building",
				filesCreated: ["index.html"],
				timeline: [{ phase: "scaffold-copy", durationMs: 1250, success: true }],
			},
			{
				sessionId: "sess-1",
				status: "completed",
				filesCreated: ["index.html", "styles.css", "styles.css"],
				timeline: [
					{ phase: "scaffold-copy", durationMs: 1250, success: true },
					{ phase: "validation", skippedReason: "not-needed" },
				],
			},
		];
		const client = fakeClient({
			status: statuses[0],
			preview: { ok: true, previewPath: "/preview/proj-1" },
		}) as ProjectClient;
		client.getBuildStatus = async () => statuses[Math.min(calls++, statuses.length - 1)]!;

		const result = await runProject(["project", "build", "--wait", "Build", "a", "demo"], client);
		const output = result.stdout.join("\n");

		expect(result.code).toBe(0);
		expect(output.match(/wrote:\s+index\.html/g)).toHaveLength(1);
		expect(output.match(/wrote:\s+styles\.css/g)).toHaveLength(1);
		expect(output).toContain("phase:   scaffold-copy 1.3s [ok]");
		expect(output).toContain("phase:   validation [skipped: not-needed]");
		expect(output).toContain("still building (1 file, 1 phase)");
	});

	it("backs off and keeps waiting when build status is rate limited", async () => {
		let calls = 0;
		const sleeps: number[] = [];
		const client = {
			startBuild: async () => ({
				sessionId: "sess-1",
				projectId: "proj-1",
				status: "building",
				model: "codebase/d4f",
			}),
			getBuildStatus: async () => {
				calls++;
				if (calls === 1) throw new ProjectClientError("request failed: 429 rate_limited", 429, 28_000);
				return {
					sessionId: "sess-1",
					status: "completed",
					projectId: "proj-1",
					filesCreated: ["index.html"],
				};
			},
			ensureBuildPreview: async () => ({ ok: true, previewPath: "/preview/proj-1" }),
			absoluteUrl: (path: string) => `https://codebase.design${path.startsWith("/") ? path : `/${path}`}`,
			hasCredentials: () => true,
		} as unknown as ProjectClient;
		const stdout: string[] = [];
		const stderr: string[] = [];

		const code = await runProjectSubcommand(["project", "build", "--wait", "Build", "a", "demo"], {
			client,
			stdout: (m) => stdout.push(m),
			stderr: (m) => stderr.push(m),
			sleep: async (ms) => {
				sleeps.push(ms);
			},
			handoffStore: null,
		});

		expect(code).toBe(0);
		expect(sleeps).toEqual([28_000]);
		expect(stdout.join("\n")).toContain("build sess-1: completed");
		expect(stderr).toEqual([]);
	});

	it("shows build status and cancel controls", async () => {
		const status = await runProject(
			["project", "status", "sess-1"],
			fakeClient({
				status: {
					sessionId: "sess-1",
					status: "failed",
					projectId: "proj-1",
					filesCreated: ["index.html", "index.html"],
					timeline: [{ phase: "validation", durationMs: 42, success: false }],
				},
			}),
		);
		expect(status.code).toBe(1);
		expect(status.stdout.join("\n")).toContain("build sess-1: failed");
		expect(status.stdout.join("\n")).toContain("files:   index.html");
		expect(status.stdout.join("\n")).toContain("phase:   validation 42ms [failed]");

		const cancel = await runProject(
			["project", "cancel", "sess-1"],
			fakeClient({ cancel: { sessionId: "sess-1", status: "cancelled", stopped: true } }),
		);
		expect(cancel.code).toBe(0);
		expect(cancel.stdout.join("\n")).toContain("cancel requested");
	});

	it("records accepted web builds and resolves latest for continuity commands", async () => {
		const dataRoot = mkdtempSync(join(tmpdir(), "project-handoff-"));
		try {
			const handoff = new BuildHandoffStore({ cwd: "/repo/app", dataRoot });
			const build = await runProject(
				["project", "build", "--model", "codebase/d4f", "--scaffold", "landing", "Build", "launch", "page"],
				fakeClient(),
				handoff,
			);

			expect(build.code).toBe(0);
			expect(build.stdout.join("\n")).toContain("latest:  codebase project status latest");
			expect(handoff.load()).toMatchObject({
				sessionId: "sess-1",
				projectId: "proj-1",
				status: "building",
				model: "codebase/d4f",
				scaffold: "landing",
				promptPreview: "Build launch page",
			});

			const seen: string[] = [];
			const client = fakeClient({
				onGetBuildStatus: (sessionId) => seen.push(`status:${sessionId}`),
				onEnsureBuildPreview: (sessionId) => seen.push(`preview:${sessionId}`),
				onCancelBuild: (sessionId) => seen.push(`cancel:${sessionId}`),
				status: { sessionId: "sess-1", status: "completed", projectId: "proj-1", model: "codebase/d4f" },
				preview: { ok: true, previewPath: "/preview/proj-1" },
				cancel: { sessionId: "sess-1", status: "cancelled", stopped: true },
			});

			const status = await runProject(["project", "status"], client, handoff);
			expect(status.code).toBe(0);
			expect(status.stdout.join("\n")).toContain("using latest web build: sess-1");
			expect(status.stdout.join("\n")).toContain("build sess-1: completed");

			const preview = await runProject(["project", "preview", "latest"], client, handoff);
			expect(preview.code).toBe(0);
			expect(preview.stdout.join("\n")).toContain("preview: https://codebase.design/preview/proj-1");

			const cancel = await runProject(["project", "cancel", "last"], client, handoff);
			expect(cancel.code).toBe(0);
			expect(cancel.stdout.join("\n")).toContain("cancel requested");
			expect(seen).toEqual(["status:sess-1", "preview:sess-1", "cancel:sess-1"]);
			expect(handoff.load()).toMatchObject({
				sessionId: "sess-1",
				status: "cancelled",
				previewUrl: "https://codebase.design/preview/proj-1",
			});

			await runProject(
				["project", "build", "Build", "another", "page"],
				fakeClient({ build: { sessionId: "sess-2", projectId: "proj-2", status: "building" } }),
				handoff,
			);
			expect(handoff.load()).toMatchObject({
				sessionId: "sess-2",
				projectId: "proj-2",
				status: "building",
				promptPreview: "Build another page",
			});
			expect(handoff.load()?.previewUrl).toBeUndefined();
		} finally {
			rmSync(dataRoot, { recursive: true, force: true });
		}
	});

	it("explains when latest status has no local handoff yet", async () => {
		const dataRoot = mkdtempSync(join(tmpdir(), "project-handoff-"));
		try {
			const result = await runProject(
				["project", "status", "latest"],
				fakeClient(),
				new BuildHandoffStore({ cwd: "/repo/app", dataRoot }),
			);

			expect(result.code).toBe(2);
			expect(result.stderr.join("\n")).toContain("no latest web build is recorded");
		} finally {
			rmSync(dataRoot, { recursive: true, force: true });
		}
	});
});
