import { describe, expect, it, vi } from "vitest";
import { notifyTurnComplete, shouldNotify } from "./notify.js";

describe("shouldNotify", () => {
	it("notifies for turns past the threshold", () => {
		expect(shouldNotify(15_000, {}, 10_000)).toBe(true);
	});

	it("stays silent for quick turns", () => {
		expect(shouldNotify(2_000, {}, 10_000)).toBe(false);
	});

	it("honors the CODEBASE_NO_NOTIFY opt-out", () => {
		expect(shouldNotify(60_000, { CODEBASE_NO_NOTIFY: "1" }, 10_000)).toBe(false);
	});
});

describe("notifyTurnComplete", () => {
	it("rings the bell when the turn was long enough", () => {
		const writes: string[] = [];
		const stdout = { write: (s: string) => writes.push(s) } as unknown as NodeJS.WritableStream;
		notifyTurnComplete({ elapsedMs: 20_000, stdout, env: {}, minMs: 10_000 });
		expect(writes).toContain("\x07");
	});

	it("does not ring for a quick turn", () => {
		const write = vi.fn();
		const stdout = { write } as unknown as NodeJS.WritableStream;
		notifyTurnComplete({ elapsedMs: 1_000, stdout, env: {}, minMs: 10_000 });
		expect(write).not.toHaveBeenCalled();
	});

	it("does not ring when opted out", () => {
		const write = vi.fn();
		const stdout = { write } as unknown as NodeJS.WritableStream;
		notifyTurnComplete({ elapsedMs: 60_000, stdout, env: { CODEBASE_NO_NOTIFY: "1" }, minMs: 10_000 });
		expect(write).not.toHaveBeenCalled();
	});
});
