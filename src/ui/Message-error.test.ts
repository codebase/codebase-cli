import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";

// errorMessageNote is unexported by Message.tsx but we don't want to widen
// Message.tsx's public surface just for tests. Instead, exercise the same
// classifier via the testable side: import-and-call. We re-export it from
// a sibling test-helper-friendly file when this becomes load-bearing —
// for now, replicate the cases the rendering relies on by importing the
// classifier directly. The function is internal but accessible via the
// CJS interop: import all named exports through the module path.
import { errorMessageNote } from "./Message.js";

function assistant(text: string, errorMessage?: string): AgentMessage & { role: "assistant" } {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: "chat",
		provider: "p",
		model: "m",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
		errorMessage,
	} as unknown as AgentMessage & { role: "assistant" };
}

describe("errorMessageNote", () => {
	it("returns null when there is no errorMessage", () => {
		expect(errorMessageNote(assistant("hi"))).toBeNull();
	});

	it("hides quirky stop reasons when the message has substantive content", () => {
		expect(errorMessageNote(assistant("a long response body", "terminated"))).toBeNull();
		expect(errorMessageNote(assistant("content", "end_turn"))).toBeNull();
		expect(errorMessageNote(assistant("content", "stop_sequence"))).toBeNull();
		expect(errorMessageNote(assistant("content", "Provider finish_reason: terminated"))).toBeNull();
	});

	it("surfaces a benign-stop errorMessage as 'empty response' when the message has no text", () => {
		const note = errorMessageNote(assistant("", "terminated"));
		expect(note?.severity).toBe("warning");
		expect(note?.text).toMatch(/empty response/i);
	});

	it("flags length / max_tokens as a truncation warning regardless of content", () => {
		const note = errorMessageNote(assistant("partial body...", "length"));
		expect(note?.severity).toBe("warning");
		expect(note?.text).toMatch(/truncated/i);
		const note2 = errorMessageNote(assistant("partial", "Provider finish_reason: max_tokens"));
		expect(note2?.severity).toBe("warning");
	});

	it("renders unknown / unrecognized errorMessages as real errors", () => {
		const note = errorMessageNote(assistant("text", "Network failure: connect ECONNREFUSED"));
		expect(note?.severity).toBe("error");
		expect(note?.text).toMatch(/^error:/);
	});

	it("trims surrounding whitespace before classifying", () => {
		expect(errorMessageNote(assistant("text", "  terminated  "))).toBeNull();
	});

	it("treats whitespace-only content as empty for the no-content branch", () => {
		const note = errorMessageNote(assistant("   ", "terminated"));
		expect(note?.severity).toBe("warning");
	});
});
