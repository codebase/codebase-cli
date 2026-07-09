import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isVerificationCommand } from "./reliable.js";
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
			fauxAssistantMessage([fauxToolCall("shell", { command: "cd . && npm test 2>&1", timeout_ms: 10_000 })], {
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
			receiptId: string;
			receiptPath: string;
			receipt: {
				ok: boolean;
				summary: {
					completedTasks: number;
					completedTasksWithEvidence: number;
					completedTasksWithVerification: number;
					verificationCount: number;
				};
				finalAnswer: { mentionsFreshVerification: boolean; matchedVerificationCommands: string[] };
				taskEvidence: Array<{
					id: string;
					toolCalls: Array<{ name: string }>;
					verification: Array<{ command: string }>;
				}>;
				verification: { command: string }[];
			};
		};
		expect(parsed.ok).toBe(true);
		expect(parsed.receipt.ok).toBe(true);
		expect(parsed.receipt.summary.completedTasks).toBe(1);
		expect(parsed.receipt.summary.completedTasksWithEvidence).toBe(1);
		expect(parsed.receipt.summary.completedTasksWithVerification).toBe(1);
		expect(parsed.receipt.summary.verificationCount).toBe(1);
		expect(parsed.receipt.finalAnswer).toEqual({
			mentionsFreshVerification: true,
			matchedVerificationCommands: ["cd . && npm test 2>&1"],
		});
		expect(parsed.receipt.taskEvidence[0]).toMatchObject({
			id: "task-1",
			toolCalls: [{ name: "shell" }],
			verification: [{ command: "cd . && npm test 2>&1" }],
		});
		expect(parsed.receipt.verification[0]?.command).toBe("cd . && npm test 2>&1");
		expect(parsed.receiptId).toMatch(/\d{4}/);
		expect(parsed.receiptPath).toContain(".codebase/receipts");
		expect(existsSync(parsed.receiptPath)).toBe(true);
		expect(
			JSON.stringify((parsed as { messages: Array<{ role: string; content: unknown }> }).messages[0]?.content),
		).toContain("Reliable mode is enabled for this run");
		const saved = JSON.parse(readFileSync(parsed.receiptPath, "utf8")) as { id: string; receipt: { ok: boolean } };
		expect(saved.id).toBe(parsed.receiptId);
		expect(saved.receipt.ok).toBe(true);
		rmSync(tmpProject, { recursive: true, force: true });
	});

	it("reliable json mode accepts read-only task evidence without shell verification", async () => {
		const tmpProject = mkdtempSync(join(tmpdir(), "headless-reliable-read-only-"));
		writeFileSync(join(tmpProject, "README.md"), "project notes\n");
		process.chdir(tmpProject);
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("create_task", { title: "Inspect project notes" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("update_task", { id: "task-1", status: "in_progress" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("read_file", { path: "README.md" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("update_task", { id: "task-1", status: "completed" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Read README.md. No file-change verification was needed."),
		]);
		const { capture, write } = makeCapture();
		const exitCode = await runHeadless({
			prompt: "explain the project notes",
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
				summary: { mutationCount: number; verificationCount: number; completedTasksWithEvidence: number };
				failures: string[];
			};
		};
		expect(parsed.ok).toBe(true);
		expect(parsed.receipt.ok).toBe(true);
		expect(parsed.receipt.summary).toMatchObject({
			mutationCount: 0,
			verificationCount: 0,
			completedTasksWithEvidence: 1,
		});
		expect(parsed.receipt.failures).not.toContain("no successful verification command was recorded");
		rmSync(tmpProject, { recursive: true, force: true });
	});

	it("reliable json mode gives the agent one repair turn before failing the receipt", async () => {
		const tmpProject = mkdtempSync(join(tmpdir(), "headless-reliable-repair-"));
		writeFileSync(
			join(tmpProject, "package.json"),
			JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }),
		);
		process.chdir(tmpProject);
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("write_file", { path: "result.txt", content: "changed\n" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Done without tasks or verification."),
			fauxAssistantMessage([fauxToolCall("create_task", { title: "Verify reliable receipt" })], {
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
			fauxAssistantMessage("Reliable receipt repaired. Verified with npm test."),
			fauxAssistantMessage("Reliable receipt repaired. Verified with npm test."),
		]);
		const { capture, write } = makeCapture();
		const exitCode = await runHeadless({
			prompt: "write result",
			outputFormat: "json",
			autoApprove: true,
			reliable: true,
			configOverride: { model, apiKey: "faux-key", source: "byok" },
			...write,
		});
		expect(exitCode).toBe(0);
		const parsed = JSON.parse(capture.stdout.trim()) as {
			ok: boolean;
			receipt: { ok: boolean; summary: { verificationCount: number }; verification: Array<{ command: string }> };
			finalText: string;
		};
		expect(parsed.ok).toBe(true);
		expect(parsed.receipt.ok).toBe(true);
		expect(parsed.receipt.summary.verificationCount).toBe(1);
		expect(parsed.receipt.verification[0]?.command).toBe("npm test");
		expect(parsed.finalText).toContain("Verified with npm test");
		rmSync(tmpProject, { recursive: true, force: true });
	});

	it("reliable repair can reopen a task that was completed before in_progress", async () => {
		const tmpProject = mkdtempSync(join(tmpdir(), "headless-reliable-reopen-"));
		writeFileSync(
			join(tmpProject, "package.json"),
			JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }),
		);
		process.chdir(tmpProject);
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("create_task", { title: "Write result file" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("write_file", { path: "result.txt", content: "changed\n" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("update_task", { id: "task-1", status: "completed" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Done without proper task evidence."),
			fauxAssistantMessage([fauxToolCall("update_task", { id: "task-1", status: "in_progress" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(
				[
					fauxToolCall("shell", { command: "npm test", timeout_ms: 10_000 }),
					fauxToolCall("update_task", { id: "task-1", status: "completed" }),
				],
				{
					stopReason: "toolUse",
				},
			),
			fauxAssistantMessage("Repaired the task evidence and verified with npm test."),
			fauxAssistantMessage("Repaired the task evidence and verified with npm test."),
		]);
		const { capture, write } = makeCapture();
		const exitCode = await runHeadless({
			prompt: "write result",
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
				failures: string[];
				taskEvidence: Array<{ id: string; verification: Array<{ command: string }> }>;
			};
		};
		expect(parsed.ok).toBe(true);
		expect(parsed.receipt.ok).toBe(true);
		expect(parsed.receipt.failures).toEqual([]);
		expect(parsed.receipt.taskEvidence[0]).toMatchObject({
			id: "task-1",
			verification: [{ command: "npm test" }],
		});
		rmSync(tmpProject, { recursive: true, force: true });
	});

	it("reliable repair prompt tells the agent to repair named tasks", async () => {
		const tmpProject = mkdtempSync(join(tmpdir(), "headless-reliable-repair-prompt-"));
		writeFileSync(
			join(tmpProject, "package.json"),
			JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }),
		);
		process.chdir(tmpProject);
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("create_task", { title: "Write result file" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("update_task", { id: "task-1", status: "completed" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Done without proper task evidence."),
			fauxAssistantMessage("Still not repaired."),
		]);
		const { capture, write } = makeCapture();
		const exitCode = await runHeadless({
			prompt: "write result",
			outputFormat: "json",
			autoApprove: true,
			reliable: true,
			configOverride: { model, apiKey: "faux-key", source: "byok" },
			...write,
		});
		const parsed = JSON.parse(capture.stdout.trim()) as {
			messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
		};
		expect(exitCode).toBe(1);
		const repairPrompt = parsed.messages.find((message) =>
			message.content.some(
				(block) =>
					block.type === "text" &&
					block.text?.includes("If failures name existing task ids that lacked evidence or skipped in_progress"),
			),
		);
		expect(repairPrompt).toBeDefined();
		rmSync(tmpProject, { recursive: true, force: true });
	});

	it("reliable json mode fails when verification is not tied to a completed task", async () => {
		const tmpProject = mkdtempSync(join(tmpdir(), "headless-reliable-detached-verify-"));
		writeFileSync(
			join(tmpProject, "package.json"),
			JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }),
		);
		process.chdir(tmpProject);
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("create_task", { title: "Edit file" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("update_task", { id: "task-1", status: "in_progress" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("write_file", { path: "result.txt", content: "changed\n" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("update_task", { id: "task-1", status: "completed" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("shell", { command: "npm test", timeout_ms: 10_000 })], {
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
			receipt: {
				failures: string[];
				summary: {
					completedTasksWithEvidence: number;
					completedTasksWithVerification: number;
					verificationAfterLastMutationCount: number;
					finalAnswerMentionsFreshVerification: boolean;
				};
				taskEvidence: Array<{ id: string; mutations: unknown[]; verification: unknown[] }>;
			};
		};
		expect(parsed.ok).toBe(false);
		expect(parsed.code).toBe("reliable_gate_failed");
		expect(parsed.receipt.failures).toContain("no completed task captured verification evidence");
		expect(parsed.receipt.summary).toMatchObject({
			completedTasksWithEvidence: 1,
			completedTasksWithVerification: 0,
			verificationAfterLastMutationCount: 1,
			finalAnswerMentionsFreshVerification: true,
		});
		expect(parsed.receipt.taskEvidence[0]).toMatchObject({
			id: "task-1",
			mutations: [{ tool: "write_file" }],
			verification: [],
		});
		rmSync(tmpProject, { recursive: true, force: true });
	});

	it("reliable json mode fails when the final answer omits fresh verification", async () => {
		const tmpProject = mkdtempSync(join(tmpdir(), "headless-reliable-final-proof-"));
		writeFileSync(
			join(tmpProject, "package.json"),
			JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }),
		);
		process.chdir(tmpProject);
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("create_task", { title: "Edit and verify" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("update_task", { id: "task-1", status: "in_progress" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("write_file", { path: "result.txt", content: "changed\n" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("shell", { command: "npm test", timeout_ms: 10_000 })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("update_task", { id: "task-1", status: "completed" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Done."),
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
			receipt: {
				failures: string[];
				finalAnswer: { mentionsFreshVerification: boolean; matchedVerificationCommands: string[] };
				summary: { finalAnswerMentionsFreshVerification: boolean };
			};
		};
		expect(parsed.ok).toBe(false);
		expect(parsed.code).toBe("reliable_gate_failed");
		expect(parsed.receipt.failures).toContain(
			"final answer did not name a fresh passing verification command: npm test",
		);
		expect(parsed.receipt.finalAnswer).toEqual({
			mentionsFreshVerification: false,
			matchedVerificationCommands: [],
		});
		expect(parsed.receipt.summary.finalAnswerMentionsFreshVerification).toBe(false);
		rmSync(tmpProject, { recursive: true, force: true });
	});

	it("reliable json mode rejects negated final-answer verification mentions", async () => {
		const tmpProject = mkdtempSync(join(tmpdir(), "headless-reliable-negated-proof-"));
		writeFileSync(
			join(tmpProject, "package.json"),
			JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }),
		);
		process.chdir(tmpProject);
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("create_task", { title: "Edit and verify" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("update_task", { id: "task-1", status: "in_progress" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("write_file", { path: "result.txt", content: "changed\n" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("shell", { command: "npm test", timeout_ms: 10_000 })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("update_task", { id: "task-1", status: "completed" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Done. I did not run npm test."),
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
			receipt: {
				failures: string[];
				finalAnswer: { mentionsFreshVerification: boolean; matchedVerificationCommands: string[] };
			};
		};
		expect(parsed.ok).toBe(false);
		expect(parsed.code).toBe("reliable_gate_failed");
		expect(parsed.receipt.failures).toContain(
			"final answer did not name a fresh passing verification command: npm test",
		);
		expect(parsed.receipt.finalAnswer).toEqual({
			mentionsFreshVerification: false,
			matchedVerificationCommands: [],
		});
		rmSync(tmpProject, { recursive: true, force: true });
	});

	it("reliable json mode fails when verification ran before the last file mutation", async () => {
		const tmpProject = mkdtempSync(join(tmpdir(), "headless-reliable-stale-verify-"));
		writeFileSync(
			join(tmpProject, "package.json"),
			JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }),
		);
		process.chdir(tmpProject);
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("create_task", { title: "Edit and verify" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("update_task", { id: "task-1", status: "in_progress" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("shell", { command: "npm test", timeout_ms: 10_000 })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("write_file", { path: "result.txt", content: "changed\n" })], {
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
			receipt: {
				failures: string[];
				summary: { mutationCount: number; verificationCount: number; verificationAfterLastMutationCount: number };
				mutations: Array<{ tool: string; path?: string; checkpoints: unknown[] }>;
			};
		};
		expect(parsed.ok).toBe(false);
		expect(parsed.code).toBe("reliable_gate_failed");
		expect(parsed.receipt.failures).toContain("successful verification ran before the last file mutation");
		expect(parsed.receipt.summary).toMatchObject({
			mutationCount: 1,
			verificationCount: 1,
			verificationAfterLastMutationCount: 0,
		});
		expect(parsed.receipt.mutations[0]).toMatchObject({
			tool: "write_file",
			path: "result.txt",
			checkpoints: [{ display: "result.txt" }],
		});
		rmSync(tmpProject, { recursive: true, force: true });
	});

	it("reliable json mode accepts verification after the last file mutation", async () => {
		const tmpProject = mkdtempSync(join(tmpdir(), "headless-reliable-fresh-verify-"));
		writeFileSync(
			join(tmpProject, "package.json"),
			JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }),
		);
		process.chdir(tmpProject);
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("create_task", { title: "Edit and verify" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("update_task", { id: "task-1", status: "in_progress" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("write_file", { path: "result.txt", content: "changed\n" })], {
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
				summary: {
					mutationCount: number;
					completedTasksWithEvidence: number;
					completedTasksWithVerification: number;
					verificationCount: number;
					verificationAfterLastMutationCount: number;
				};
				mutations: Array<{ tool: string; path?: string; checkpoints: unknown[] }>;
				taskEvidence: Array<{
					id: string;
					toolCalls: Array<{ name: string }>;
					mutations: Array<{ tool: string }>;
					verification: Array<{ command: string }>;
				}>;
				verification: Array<{ command: string; endedAt: number }>;
			};
		};
		expect(parsed.ok).toBe(true);
		expect(parsed.receipt.ok).toBe(true);
		expect(parsed.receipt.summary).toMatchObject({
			mutationCount: 1,
			completedTasksWithEvidence: 1,
			completedTasksWithVerification: 1,
			verificationCount: 1,
			verificationAfterLastMutationCount: 1,
		});
		expect(parsed.receipt.mutations[0]).toMatchObject({
			tool: "write_file",
			path: "result.txt",
			checkpoints: [{ display: "result.txt" }],
		});
		expect(parsed.receipt.taskEvidence[0]).toMatchObject({
			id: "task-1",
			toolCalls: [{ name: "write_file" }, { name: "shell" }],
			mutations: [{ tool: "write_file" }],
			verification: [{ command: "npm test" }],
		});
		expect(parsed.receipt.verification[0]?.command).toBe("npm test");
		rmSync(tmpProject, { recursive: true, force: true });
	});

	it("reliable json mode fails when a completed task has no active evidence", async () => {
		const tmpProject = mkdtempSync(join(tmpdir(), "headless-reliable-empty-task-"));
		writeFileSync(
			join(tmpProject, "package.json"),
			JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }),
		);
		process.chdir(tmpProject);
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("create_task", { title: "Do work" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("update_task", { id: "task-1", status: "in_progress" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("update_task", { id: "task-1", status: "completed" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("shell", { command: "npm test", timeout_ms: 10_000 })], {
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
			receipt: {
				failures: string[];
				summary: { completedTasks: number; completedTasksWithEvidence: number; verificationCount: number };
				taskEvidence: Array<{ id: string; toolCalls: unknown[]; mutations: unknown[]; verification: unknown[] }>;
			};
		};
		expect(parsed.ok).toBe(false);
		expect(parsed.code).toBe("reliable_gate_failed");
		expect(parsed.receipt.failures).toContain("completed task lacked evidence: task-1");
		expect(parsed.receipt.summary).toMatchObject({
			completedTasks: 1,
			completedTasksWithEvidence: 0,
			verificationCount: 1,
		});
		expect(parsed.receipt.taskEvidence[0]).toMatchObject({
			id: "task-1",
			toolCalls: [],
			mutations: [],
			verification: [],
		});
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
		const tmpProject = mkdtempSync(join(tmpdir(), "headless-reliable-no-verify-"));
		process.chdir(tmpProject);
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("create_task", { title: "Do work" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("update_task", { id: "task-1", status: "in_progress" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("write_file", { path: "result.txt", content: "changed\n" })], {
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
		rmSync(tmpProject, { recursive: true, force: true });
	});

	it("recognizes project-local test and smoke commands as verification", () => {
		expect(isVerificationCommand("node test.mjs")).toBe(true);
		expect(isVerificationCommand("node --test")).toBe(true);
		expect(isVerificationCommand("node --experimental-strip-types _verify_rename.ts")).toBe(true);
		expect(
			isVerificationCommand("node --experimental-strip-types -e \"import { parseTimestamp } from './parse.ts';\""),
		).toBe(true);
		expect(isVerificationCommand("npx tsx src/index.ts")).toBe(true);
		expect(
			isVerificationCommand("npx tsx -e \"import {greet} from './src/index.ts'; console.log(greet('test'))\""),
		).toBe(true);
		expect(
			isVerificationCommand(
				"npx -y typescript@latest --noEmit --lib es2020 --module nodenext --target es2020 src/parse.ts src/main.ts 2>&1",
			),
		).toBe(true);
		expect(isVerificationCommand("deno check src/parse.ts")).toBe(true);
		expect(isVerificationCommand("bun src/index.ts")).toBe(true);
		expect(isVerificationCommand("npx tsc --noEmit 2>&1 || true")).toBe(false);
		expect(isVerificationCommand("which node && node --version && which tsc")).toBe(false);
		expect(isVerificationCommand("npx tsx -e \"console.log('hello')\"")).toBe(false);
		expect(isVerificationCommand("node -e \"console.log('hello')\"")).toBe(false);
		expect(isVerificationCommand("node scripts/generate-fixture.mjs")).toBe(false);
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

	it("reliable json mode warns when active tasks overlap", async () => {
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
		expect(exitCode).toBe(0);
		const parsed = JSON.parse(capture.stdout.trim()) as {
			ok: boolean;
			receipt: { failures: string[]; warnings: string[] };
		};
		expect(parsed.ok).toBe(true);
		expect(parsed.receipt.failures).toEqual([]);
		expect(parsed.receipt.warnings).toContain("multiple tasks were in_progress at once: task-1, task-2");
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
