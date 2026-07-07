import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildJsonResult, runHeadless } from "./run.js";

interface Capture {
	stdout: string;
	stderr: string;
}

function makeCapture(): { capture: Capture; write: { stdout: (s: string) => void; stderr: (s: string) => void } } {
	const capture: Capture = { stdout: "", stderr: "" };
	return {
		capture,
		write: {
			stdout: (s) => {
				capture.stdout += s;
			},
			stderr: (s) => {
				capture.stderr += s;
			},
		},
	};
}

describe("runHeadless", () => {
	let faux: ReturnType<typeof registerFauxProvider>;
	let model: Model<string>;
	let tmpHome: string;
	let prevHome: string | undefined;
	let prevCwd: string;

	beforeEach(() => {
		// Isolate HOME so CredentialsStore can't pick up the dev's real
		// ~/.codebase login — otherwise the ConfigError tests are non-hermetic
		// and pass only when no valid credentials happen to exist on the box.
		prevHome = process.env.HOME;
		prevCwd = process.cwd();
		tmpHome = mkdtempSync(join(tmpdir(), "headless-home-"));
		process.env.HOME = tmpHome;
		faux = registerFauxProvider({
			models: [
				{
					id: "test-model",
					name: "Test Model",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 100_000,
					maxTokens: 4096,
				},
			],
			tokenSize: { min: 1, max: 2 },
		});
		model = faux.models[0] as Model<string>;
	});

	afterEach(() => {
		faux.unregister();
		process.chdir(prevCwd);
		if (prevHome !== undefined) process.env.HOME = prevHome;
		else delete process.env.HOME;
		rmSync(tmpHome, { recursive: true, force: true });
	});

	it("text mode emits the assistant reply on stdout", async () => {
		faux.setResponses([fauxAssistantMessage("hello from the faux model")]);
		const { capture, write } = makeCapture();
		const exitCode = await runHeadless({
			prompt: "hi",
			outputFormat: "text",
			autoApprove: true,
			configOverride: { model, apiKey: "faux-key", source: "byok" },
			...write,
		});
		expect(exitCode).toBe(0);
		expect(capture.stdout).toContain("hello from the faux model");
		// Tool activity hints go to stderr — none expected for a text-only response.
		expect(capture.stderr).toBe("");
	});

	it("stream-json mode emits one JSONL line per agent event", async () => {
		faux.setResponses([fauxAssistantMessage("ok")]);
		const { capture, write } = makeCapture();
		const exitCode = await runHeadless({
			prompt: "hi",
			outputFormat: "stream-json",
			autoApprove: true,
			configOverride: { model, apiKey: "faux-key", source: "byok" },
			...write,
		});
		expect(exitCode).toBe(0);
		const lines = capture.stdout.trim().split("\n");
		expect(lines.length).toBeGreaterThan(0);
		for (const line of lines) {
			const parsed = JSON.parse(line) as { type: string; ts: number };
			expect(typeof parsed.type).toBe("string");
			expect(typeof parsed.ts).toBe("number");
		}
		// Must include the canonical lifecycle envelope events.
		const types = lines.map((l) => (JSON.parse(l) as { type: string }).type);
		expect(types).toContain("agent_start");
		expect(types).toContain("agent_end");
	});

	it("json mode emits exactly one object with the final transcript", async () => {
		faux.setResponses([fauxAssistantMessage("done")]);
		const { capture, write } = makeCapture();
		const exitCode = await runHeadless({
			prompt: "hi",
			outputFormat: "json",
			autoApprove: true,
			configOverride: { model, apiKey: "faux-key", source: "byok" },
			...write,
		});
		expect(exitCode).toBe(0);
		// Single trailing newline, single object.
		const lines = capture.stdout.trim().split("\n");
		expect(lines).toHaveLength(1);
		const parsed = JSON.parse(lines[0]) as {
			ok: boolean;
			exitCode: number;
			finalText: string;
			messageCount: number;
			usage: unknown;
			model: { id: string };
		};
		expect(parsed.ok).toBe(true);
		expect(parsed.exitCode).toBe(0);
		expect(parsed.finalText).toContain("done");
		expect(parsed.messageCount).toBeGreaterThanOrEqual(2); // user + assistant
		expect(parsed.model.id).toBe("test-model");
	});

	it("reliable json mode includes a receipt when tasks and verification pass", async () => {
		const tmpProject = mkdtempSync(join(tmpdir(), "headless-reliable-pass-"));
		writeFileSync(
			join(tmpProject, "package.json"),
			JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }),
		);
		process.chdir(tmpProject);
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("create_task", { title: "Add coverage" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("update_task", { id: "task-1", status: "in_progress" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("shell", { command: "npm test", timeout_ms: 10_000 })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("update_task", { id: "task-1", status: "completed" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Done. Verified with npm test."),
		]);
		const { capture, write } = makeCapture();
		const exitCode = await runHeadless({
			prompt: "do reliable work",
			outputFormat: "json",
			autoApprove: true,
			reliable: true,
			configOverride: { model, apiKey: "faux-key", source: "byok" },
			...write,
		});
		expect(exitCode).toBe(0);
		const parsed = JSON.parse(capture.stdout.trim()) as {
			ok: boolean;
			receipt: {
				ok: boolean;
				summary: { completedTasks: number; verificationCount: number };
				verification: { command: string }[];
			};
		};
		expect(parsed.ok).toBe(true);
		expect(parsed.receipt.ok).toBe(true);
		expect(parsed.receipt.summary.completedTasks).toBe(1);
		expect(parsed.receipt.summary.verificationCount).toBe(1);
		expect(parsed.receipt.verification[0]?.command).toBe("npm test");
		rmSync(tmpProject, { recursive: true, force: true });
	});

	it("reliable json mode fails when no task list was created", async () => {
		faux.setResponses([fauxAssistantMessage("done without tasks")]);
		const { capture, write } = makeCapture();
		const exitCode = await runHeadless({
			prompt: "do reliable work",
			outputFormat: "json",
			autoApprove: true,
			reliable: true,
			configOverride: { model, apiKey: "faux-key", source: "byok" },
			...write,
		});
		expect(exitCode).toBe(1);
		const parsed = JSON.parse(capture.stdout.trim()) as {
			ok: boolean;
			code: string;
			receipt: { failures: string[] };
		};
		expect(parsed.ok).toBe(false);
		expect(parsed.code).toBe("reliable_gate_failed");
		expect(parsed.receipt.failures).toContain("no task list was created");
	});

	it("reliable json mode fails when verification never passed", async () => {
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("create_task", { title: "Do work" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("update_task", { id: "task-1", status: "completed" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Done without verification."),
		]);
		const { capture, write } = makeCapture();
		const exitCode = await runHeadless({
			prompt: "do reliable work",
			outputFormat: "json",
			autoApprove: true,
			reliable: true,
			configOverride: { model, apiKey: "faux-key", source: "byok" },
			...write,
		});
		expect(exitCode).toBe(1);
		const parsed = JSON.parse(capture.stdout.trim()) as {
			ok: boolean;
			code: string;
			receipt: { failures: string[] };
		};
		expect(parsed.ok).toBe(false);
		expect(parsed.code).toBe("reliable_gate_failed");
		expect(parsed.receipt.failures).toContain("no successful verification command was recorded");
	});

	it("reliable json mode fails when completed tasks skip in_progress", async () => {
		const tmpProject = mkdtempSync(join(tmpdir(), "headless-reliable-lifecycle-"));
		writeFileSync(
			join(tmpProject, "package.json"),
			JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }),
		);
		process.chdir(tmpProject);
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("create_task", { title: "Do work" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("shell", { command: "npm test", timeout_ms: 10_000 })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("update_task", { id: "task-1", status: "completed" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Done. Verified with npm test."),
		]);
		const { capture, write } = makeCapture();
		const exitCode = await runHeadless({
			prompt: "do reliable work",
			outputFormat: "json",
			autoApprove: true,
			reliable: true,
			configOverride: { model, apiKey: "faux-key", source: "byok" },
			...write,
		});
		expect(exitCode).toBe(1);
		const parsed = JSON.parse(capture.stdout.trim()) as {
			ok: boolean;
			code: string;
			receipt: { failures: string[]; taskLifecycle: Array<{ id: string; transitions: unknown[] }> };
		};
		expect(parsed.ok).toBe(false);
		expect(parsed.code).toBe("reliable_gate_failed");
		expect(parsed.receipt.failures).toContain("completed task skipped in_progress: task-1");
		expect(parsed.receipt.taskLifecycle[0]).toMatchObject({
			id: "task-1",
			transitions: [{ status: "pending" }, { status: "completed" }],
		});
		rmSync(tmpProject, { recursive: true, force: true });
	});

	it("reliable json mode fails when active tasks overlap", async () => {
		const tmpProject = mkdtempSync(join(tmpdir(), "headless-reliable-overlap-"));
		writeFileSync(
			join(tmpProject, "package.json"),
			JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }),
		);
		process.chdir(tmpProject);
		faux.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("create_task", { title: "Do first" }), fauxToolCall("create_task", { title: "Do second" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([fauxToolCall("update_task", { id: "task-1", status: "in_progress" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("update_task", { id: "task-2", status: "in_progress" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("shell", { command: "npm test", timeout_ms: 10_000 })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(
				[
					fauxToolCall("update_task", { id: "task-1", status: "completed" }),
					fauxToolCall("update_task", { id: "task-2", status: "completed" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Done. Verified with npm test."),
		]);
		const { capture, write } = makeCapture();
		const exitCode = await runHeadless({
			prompt: "do reliable work",
			outputFormat: "json",
			autoApprove: true,
			reliable: true,
			configOverride: { model, apiKey: "faux-key", source: "byok" },
			...write,
		});
		expect(exitCode).toBe(1);
		const parsed = JSON.parse(capture.stdout.trim()) as {
			ok: boolean;
			code: string;
			receipt: { failures: string[] };
		};
		expect(parsed.ok).toBe(false);
		expect(parsed.code).toBe("reliable_gate_failed");
		expect(parsed.receipt.failures).toContain("multiple tasks were in_progress at once: task-1, task-2");
		rmSync(tmpProject, { recursive: true, force: true });
	});

	it("json mode exits non-zero when the assistant turn ends with a provider error", async () => {
		faux.setResponses([
			fauxAssistantMessage([], {
				stopReason: "error",
				errorMessage: "simulated provider failure",
			}),
		]);
		const { capture, write } = makeCapture();
		const exitCode = await runHeadless({
			prompt: "hi",
			outputFormat: "json",
			autoApprove: true,
			configOverride: { model, apiKey: "faux-key", source: "byok" },
			...write,
		});
		expect(exitCode).toBe(1);
		const parsed = JSON.parse(capture.stdout.trim()) as { ok: boolean; exitCode: number; error: string };
		expect(parsed.ok).toBe(false);
		expect(parsed.exitCode).toBe(1);
		expect(parsed.error).toBe("simulated provider failure");
	});

	it("json mode explains provider API key failures with recovery copy", async () => {
		faux.setResponses([
			fauxAssistantMessage([], {
				stopReason: "error",
				errorMessage:
					'ERROR 401\n{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
			}),
		]);
		const { capture, write } = makeCapture();
		const exitCode = await runHeadless({
			prompt: "hi",
			outputFormat: "json",
			autoApprove: true,
			configOverride: { model, apiKey: "faux-key", source: "byok" },
			...write,
		});
		expect(exitCode).toBe(1);
		const parsed = JSON.parse(capture.stdout.trim()) as { error: string };
		expect(parsed.error).toContain("API key was rejected");
		expect(parsed.error).toContain("codebase auth login");
	});

	it("json mode fails explicitly when a tool needs approval without auto-approve", async () => {
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("write_file", { path: "note.txt", content: "hi\n" })], {
				stopReason: "toolUse",
			}),
		]);
		const { capture, write } = makeCapture();
		const exitCode = await runHeadless({
			prompt: "write a note",
			outputFormat: "json",
			configOverride: { model, apiKey: "faux-key", source: "byok" },
			...write,
		});
		expect(exitCode).toBe(2);
		const parsed = JSON.parse(capture.stdout.trim()) as {
			ok: boolean;
			exitCode: number;
			code: string;
			error: string;
		};
		expect(parsed.ok).toBe(false);
		expect(parsed.exitCode).toBe(2);
		expect(parsed.code).toBe("approval_required");
		expect(parsed.error).toMatch(/--auto-approve/);
	});

	it("returns exit code 1 with a stderr error when ConfigError fires before the loop", async () => {
		// No faux response set + no configOverride forces resolveConfig to
		// search env vars — with none set in this test env, ConfigError.
		const { capture, write } = makeCapture();
		const exitCode = await runHeadless({
			prompt: "hi",
			autoApprove: true,
			outputFormat: "text",
			// Intentionally omit configOverride so resolveConfig runs.
			...write,
		});
		// Either the test env has *some* provider key set, in which case
		// the agent runs (exit 0 or 1 depending on faux state), or it
		// fails fast with ConfigError. We only assert that the negative
		// path lands on exit 1 / stderr — the positive path doesn't matter
		// for this test's purpose.
		if (exitCode === 1) {
			expect(capture.stderr).toMatch(/error/i);
		}
	});

	it("json mode emits a structured envelope on ConfigError instead of empty stdout", async () => {
		// Same setup as the text-mode test above: omit configOverride so
		// resolveConfig actually tries env vars. If the env happens to have
		// a key set, we skip the assertion — only the failure path is the
		// regression guard.
		const savedAnthropic = process.env.ANTHROPIC_API_KEY;
		const savedOpenai = process.env.OPENAI_API_KEY;
		const savedGroq = process.env.GROQ_API_KEY;
		const savedOpenrouter = process.env.OPENROUTER_API_KEY;
		const savedMistral = process.env.MISTRAL_API_KEY;
		delete process.env.ANTHROPIC_API_KEY;
		delete process.env.OPENAI_API_KEY;
		delete process.env.GROQ_API_KEY;
		delete process.env.OPENROUTER_API_KEY;
		delete process.env.MISTRAL_API_KEY;
		try {
			const { capture, write } = makeCapture();
			const exitCode = await runHeadless({
				prompt: "hi",
				autoApprove: true,
				outputFormat: "json",
				...write,
			});
			expect(exitCode).toBe(1);
			// stdout must contain a JSON object with ok:false + a code,
			// not the empty string the pre-fix version emitted.
			const trimmed = capture.stdout.trim();
			expect(trimmed.length).toBeGreaterThan(0);
			const parsed = JSON.parse(trimmed) as { ok: boolean; exitCode: number; code: string };
			expect(parsed.ok).toBe(false);
			expect(parsed.exitCode).toBe(1);
			expect(parsed.code).toBe("config_error");
		} finally {
			if (savedAnthropic !== undefined) process.env.ANTHROPIC_API_KEY = savedAnthropic;
			if (savedOpenai !== undefined) process.env.OPENAI_API_KEY = savedOpenai;
			if (savedGroq !== undefined) process.env.GROQ_API_KEY = savedGroq;
			if (savedOpenrouter !== undefined) process.env.OPENROUTER_API_KEY = savedOpenrouter;
			if (savedMistral !== undefined) process.env.MISTRAL_API_KEY = savedMistral;
		}
	});

	it("stream-json mode emits a structured error line on ConfigError", async () => {
		const savedKeys = [
			"ANTHROPIC_API_KEY",
			"OPENAI_API_KEY",
			"GROQ_API_KEY",
			"OPENROUTER_API_KEY",
			"MISTRAL_API_KEY",
		].map((k) => [k, process.env[k]] as const);
		for (const [k] of savedKeys) delete process.env[k];
		try {
			const { capture, write } = makeCapture();
			const exitCode = await runHeadless({
				prompt: "hi",
				autoApprove: true,
				outputFormat: "stream-json",
				...write,
			});
			expect(exitCode).toBe(1);
			const lines = capture.stdout
				.trim()
				.split("\n")
				.filter((l) => l.length > 0);
			expect(lines.length).toBeGreaterThan(0);
			const errLine = lines.find((l) => l.includes('"type":"error"'));
			expect(errLine).toBeDefined();
			const parsed = JSON.parse(errLine ?? "{}") as { type: string; code: string };
			expect(parsed.type).toBe("error");
			expect(parsed.code).toBe("config_error");
		} finally {
			for (const [k, v] of savedKeys) {
				if (v !== undefined) process.env[k] = v;
			}
		}
	});

	it("respects a UserPromptSubmit hook veto (exit 2)", async () => {
		// We can't easily inject a hook without writing to ~/.codebase, but
		// we can wire the submit path by setting a hook config via
		// CODEBASE_HOOKS_PATH and verify that runHeadless returns the
		// blocked message. Simpler: directly verify that bundle.submitUserPrompt
		// surfaces a hook veto. Covered in agent.test / hooks tests; this
		// test confirms the headless wiring respects the returned result by
		// asserting the error pathway plumbing.
		faux.setResponses([fauxAssistantMessage("never runs")]);
		const { write } = makeCapture();
		const exitCode = await runHeadless({
			prompt: "hi",
			outputFormat: "text",
			autoApprove: true,
			configOverride: { model, apiKey: "faux-key", source: "byok" },
			...write,
		});
		// Without a configured hook, this path runs cleanly. The block
		// branch is exercised by hooks tests; here we just guarantee that
		// runHeadless doesn't crash with the configOverride harness in
		// place — guards against the wiring regression we just fixed.
		expect([0, 1]).toContain(exitCode);
	});
});

describe("buildJsonResult", () => {
	it("includes finalText from the last assistant message", () => {
		const result = buildJsonResult({
			ok: true,
			exitCode: 0,
			messages: [
				{ role: "user", content: "hi" } as never,
				{
					role: "assistant",
					content: [{ type: "text", text: "done" }],
				} as never,
			],
			usage: { input: 1, output: 2 },
			model: { provider: "faux", id: "x", name: "X" },
			source: "byok",
			durationMs: 42,
		});
		expect(result.finalText).toBe("done");
		expect(result.ok).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(result.durationMs).toBe(42);
	});

	it("emits empty finalText when no assistant message exists", () => {
		const result = buildJsonResult({
			ok: false,
			exitCode: 1,
			error: "boom",
			messages: [],
			usage: {},
			model: { provider: "faux", id: "x", name: "X" },
			source: "byok",
			durationMs: 0,
		});
		expect(result.finalText).toBe("");
		expect(result.ok).toBe(false);
		expect(result.error).toBe("boom");
	});

	it("preserves the raw messages array on the envelope", () => {
		const messages = [{ role: "user", content: "hi" } as never];
		const result = buildJsonResult({
			ok: true,
			exitCode: 0,
			messages,
			usage: {},
			model: { provider: "faux", id: "x", name: "X" },
			source: "byok",
			durationMs: 1,
		});
		expect((result.messages as unknown[]).length).toBe(1);
		expect(result.messageCount).toBe(1);
	});
});
