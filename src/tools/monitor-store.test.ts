import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackgroundShellStore } from "./background-shell-store.js";
import { type MonitorMatchEvent, MonitorStore } from "./monitor-store.js";

async function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil<T>(fn: () => T | undefined, timeoutMs = 4000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const v = fn();
		if (v !== undefined) return v;
		await wait(20);
	}
	throw new Error("waitUntil timed out");
}

describe("MonitorStore", () => {
	let bg: BackgroundShellStore;
	let monitors: MonitorStore;
	let captured: MonitorMatchEvent[];
	let unsub: () => void;

	beforeEach(() => {
		bg = new BackgroundShellStore();
		monitors = new MonitorStore(bg);
		captured = [];
		unsub = monitors.onMatch((e) => captured.push(e));
	});

	afterEach(() => {
		unsub();
		bg.killAllSync();
	});

	it("emits a match event for every line when no regex is set", async () => {
		const record = bg.spawn("printf 'one\\ntwo\\nthree\\n'", process.cwd());
		monitors.register({ taskId: record.id });
		await waitUntil(() => (captured.length >= 3 ? captured : undefined));
		expect(captured.map((e) => e.line)).toEqual(["one", "two", "three"]);
	});

	it("filters lines by regex", async () => {
		const record = bg.spawn("printf 'info: ok\\nERROR: bad\\ninfo: ok\\nFATAL: dead\\n'", process.cwd());
		monitors.register({ taskId: record.id, regex: /ERROR|FATAL/ });
		await waitUntil(() => (captured.length >= 2 ? captured : undefined));
		expect(captured.map((e) => e.line)).toEqual(["ERROR: bad", "FATAL: dead"]);
	});

	it("auto-unregisters after maxMatches is reached", async () => {
		const record = bg.spawn("printf 'one\\ntwo\\nthree\\nfour\\n'", process.cwd());
		const mon = monitors.register({ taskId: record.id, maxMatches: 2 });
		await waitUntil(() => (captured.length >= 2 ? captured : undefined));
		await wait(100);
		expect(captured.length).toBe(2);
		expect(monitors.get(mon.id)).toBeUndefined();
	});

	it("auto-cleans the monitor when the watched shell exits", async () => {
		const record = bg.spawn("printf 'hi\\n' && true", process.cwd());
		const mon = monitors.register({ taskId: record.id });
		// Wait until the shell exits.
		await waitUntil(() => (bg.get(record.id)?.status === "exited" ? true : undefined));
		// The subscription is dropped synchronously in the BgShell exit
		// handler; the MonitorStore subscriber sees the status flip and
		// removes the monitor. Give one event-loop tick to settle.
		await wait(20);
		expect(monitors.get(mon.id)).toBeUndefined();
	});

	it("remove() returns true the first time, false on a repeat", async () => {
		const record = bg.spawn("sleep 1", process.cwd());
		const mon = monitors.register({ taskId: record.id });
		expect(monitors.remove(mon.id)).toBe(true);
		expect(monitors.remove(mon.id)).toBe(false);
	});

	it("buffers a partial-line tail across chunks", async () => {
		// We can't easily split chunks at the test level — printf delivers
		// in one chunk on this platform. Verify behavior by registering
		// after some output has already been buffered by hand-feeding the
		// subscriber: directly exercise consumeChunk via a fake by spawning
		// a process that emits two writes (sleep between them).
		const record = bg.spawn("printf 'partial-' && sleep 0.05 && printf 'line\\ndone\\n'", process.cwd());
		monitors.register({ taskId: record.id });
		await waitUntil(() => (captured.length >= 2 ? captured : undefined));
		expect(captured.map((e) => e.line)).toEqual(["partial-line", "done"]);
	});

	it("a misbehaving listener doesn't break the others", async () => {
		const record = bg.spawn("printf 'x\\ny\\n'", process.cwd());
		const noisy = vi.fn(() => {
			throw new Error("boom");
		});
		monitors.onMatch(noisy);
		monitors.register({ taskId: record.id });
		await waitUntil(() => (captured.length >= 2 ? captured : undefined));
		expect(noisy).toHaveBeenCalled();
		expect(captured.length).toBe(2);
	});
});
