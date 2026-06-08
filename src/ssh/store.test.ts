import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SshStore } from "./store.js";

describe("SshStore", () => {
	let home: string;
	let store: SshStore;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "codebase-ssh-store-"));
		store = new SshStore({ home });
	});

	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
	});

	it("starts empty when no file exists", () => {
		expect(store.list()).toEqual([]);
	});

	it("add persists a host to disk", () => {
		store.add({ name: "staging", host: "staging.example" });
		expect(store.list()).toEqual([{ name: "staging", host: "staging.example" }]);
		const onDisk = JSON.parse(readFileSync(store.filePath, "utf8"));
		expect(onDisk.hosts).toEqual([{ name: "staging", host: "staging.example" }]);
	});

	it("add overwrites an existing host with the same name", () => {
		store.add({ name: "x", host: "first.example" });
		store.add({ name: "x", host: "second.example" });
		const hosts = store.list();
		expect(hosts).toHaveLength(1);
		expect(hosts[0].host).toBe("second.example");
	});

	it("rm removes a host and returns true; returns false on miss", () => {
		store.add({ name: "x", host: "x.example" });
		expect(store.remove("x")).toBe(true);
		expect(store.list()).toEqual([]);
		expect(store.remove("x")).toBe(false);
	});

	it("rejects names that don't match the safe pattern", () => {
		expect(() => store.add({ name: "Has Spaces", host: "x" })).toThrow(/must match/);
		expect(() => store.add({ name: "../etc", host: "x" })).toThrow(/must match/);
	});

	it("writes the config file with 0600 mode", () => {
		if (process.platform === "win32") return; // POSIX-only file mode
		store.add({ name: "x", host: "x.example" });
		const mode = statSync(store.filePath).mode & 0o777;
		expect(mode).toBe(0o600);
	});
});
