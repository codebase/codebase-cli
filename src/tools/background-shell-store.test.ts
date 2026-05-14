import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BackgroundShellStore } from "./background-shell-store.js";

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil<T>(check: () => T | undefined, timeoutMs = 2000): Promise<T> {
	const start = Date.now();
	for (;;) {
		const v = check();
		if (v !== undefined) return v;
		if (Date.now() - start > timeoutMs) throw new Error("waitUntil: timeout");
		await wait(15);
	}
}

describe("BackgroundShellStore", () => {
	let store: BackgroundShellStore;

	beforeEach(() => {
		store = new BackgroundShellStore();
	});

	afterEach(() => {
		store.killAllSync();
	});

	it("spawns a short-lived command, captures output, and marks exited", async () => {
		const record = store.spawn("echo hello world", process.cwd());
		expect(record.status).toBe("running");
		expect(record.id).toMatch(/^bg-\d+$/);
		const final = await waitUntil(() => {
			const cur = store.get(record.id);
			return cur && cur.status !== "running" ? cur : undefined;
		});
		expect(final.status).toBe("exited");
		expect(final.exitCode).toBe(0);
		expect(final.output).toContain("hello world");
	});

	it("captures stderr alongside stdout", async () => {
		const record = store.spawn("printf 'err\\n' 1>&2; printf 'out\\n'", process.cwd());
		const final = await waitUntil(() => {
			const cur = store.get(record.id);
			return cur && cur.status !== "running" ? cur : undefined;
		});
		expect(final.output).toContain("err");
		expect(final.output).toContain("out");
	});

	it("kill() terminates a long-running shell and marks it killed", async () => {
		const record = store.spawn("sleep 30", process.cwd());
		expect(store.get(record.id)?.status).toBe("running");
		await store.kill(record.id);
		const final = store.get(record.id);
		expect(final?.status).toBe("killed");
		expect(final?.endedAt).toBeGreaterThan(0);
	});

	it("kill() on an unknown id reports not-found", async () => {
		await expect(store.kill("does-not-exist")).resolves.toEqual({ outcome: "not-found" });
	});

	it("kill() on an already-exited shell reports already-exited", async () => {
		const record = store.spawn("true", process.cwd());
		await waitUntil(() => (store.get(record.id)?.status !== "running" ? true : undefined));
		await expect(store.kill(record.id)).resolves.toEqual({ outcome: "already-exited" });
	});

	it("killAllSync() SIGTERMs every running shell", async () => {
		const a = store.spawn("sleep 30", process.cwd());
		const b = store.spawn("sleep 30", process.cwd());
		store.killAllSync();
		await waitUntil(() => {
			const ra = store.get(a.id);
			const rb = store.get(b.id);
			return ra && rb && ra.status !== "running" && rb.status !== "running" ? true : undefined;
		});
		expect(store.get(a.id)?.status).toBe("killed");
		expect(store.get(b.id)?.status).toBe("killed");
	});

	it("subscribe() fires on spawn, output growth, and exit", async () => {
		const events: number[] = [];
		const unsubscribe = store.subscribe((shells) => events.push(shells.length));
		const a = store.spawn("echo a", process.cwd());
		await waitUntil(() => (store.get(a.id)?.status !== "running" ? true : undefined));
		unsubscribe();
		// First event is the initial snapshot (empty); then spawn → output → exit
		expect(events[0]).toBe(0);
		expect(events.length).toBeGreaterThan(1);
	});

	it("assigns unique sequential ids", () => {
		const a = store.spawn("true", process.cwd());
		const b = store.spawn("true", process.cwd());
		expect(a.id).not.toBe(b.id);
	});

	it("list() returns oldest-first", () => {
		const a = store.spawn("true", process.cwd());
		const b = store.spawn("true", process.cwd());
		const ids = store.list().map((r) => r.id);
		expect(ids).toEqual([a.id, b.id]);
	});

	it("returns copies from get() / list() so callers can't mutate live state", () => {
		const record = store.spawn("true", process.cwd());
		const copy = store.get(record.id);
		// biome-ignore lint/style/noNonNullAssertion: just spawned, definitely present
		copy!.output = "tampered";
		expect(store.get(record.id)?.output).not.toBe("tampered");
	});
});
