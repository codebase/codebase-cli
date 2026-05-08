import { describe, expect, it, vi } from "vitest";
import { PermissionStore } from "./store.js";

describe("PermissionStore.shouldAutoAllow", () => {
	it("auto-allows read-only tools", async () => {
		const store = new PermissionStore();
		await expect(store.evaluate("read_file", { path: "x" })).resolves.toBe("allow");
		await expect(store.evaluate("grep", { pattern: "x" })).resolves.toBe("allow");
		await expect(store.evaluate("git_status", {})).resolves.toBe("allow");
	});

	it("auto-allows shell when command is on the read-only allowlist", async () => {
		const store = new PermissionStore();
		await expect(store.evaluate("shell", { command: "ls -la" })).resolves.toBe("allow");
		await expect(store.evaluate("shell", { command: "git log --oneline" })).resolves.toBe("allow");
	});

	it("queues a prompt for non-allowlisted shell commands", () => {
		const store = new PermissionStore();
		const promise = store.evaluate("shell", { command: "rm file.txt" });
		expect(store.current()).toMatchObject({ tool: "shell" });
		store.respond(store.current()!.id, "deny");
		return expect(promise).resolves.toBe("block");
	});

	it("queues a prompt for write_file even though FileStateCache also gates it", () => {
		const store = new PermissionStore();
		const promise = store.evaluate("write_file", { path: "src/foo.ts", content: "x" });
		expect(store.current()).toMatchObject({ tool: "write_file" });
		store.respond(store.current()!.id, "allow-once");
		return expect(promise).resolves.toBe("allow");
	});
});

describe("PermissionStore trust state", () => {
	it("trust-tool allows future calls of the same tool without prompting", async () => {
		const store = new PermissionStore();
		const first = store.evaluate("write_file", { path: "a.ts" });
		store.respond(store.current()!.id, "trust-tool");
		await expect(first).resolves.toBe("allow");

		// Second call goes through without queuing
		await expect(store.evaluate("write_file", { path: "b.ts" })).resolves.toBe("allow");
		expect(store.current()).toBeUndefined();
	});

	it("trust-tool does not leak to other tools", async () => {
		const store = new PermissionStore();
		const first = store.evaluate("write_file", { path: "a.ts" });
		store.respond(store.current()!.id, "trust-tool");
		await first;

		const second = store.evaluate("edit_file", { path: "b.ts", old_string: "x", new_string: "y" });
		// Should be queued, not auto-allowed
		expect(store.current()).toMatchObject({ tool: "edit_file" });
		store.respond(store.current()!.id, "deny");
		await expect(second).resolves.toBe("block");
	});

	it("trust-all auto-allows everything for the rest of the session", async () => {
		const store = new PermissionStore();
		const first = store.evaluate("shell", { command: "rm file" });
		store.respond(store.current()!.id, "trust-all");
		await expect(first).resolves.toBe("allow");

		await expect(store.evaluate("write_file", { path: "x" })).resolves.toBe("allow");
		await expect(store.evaluate("git_commit", { message: "wip" })).resolves.toBe("allow");
	});

	it("clear() resets trust state", async () => {
		const store = new PermissionStore();
		const first = store.evaluate("write_file", { path: "x" });
		store.respond(store.current()!.id, "trust-tool");
		await first;

		store.clear();
		const next = store.evaluate("write_file", { path: "y" });
		expect(store.current()).toBeDefined();
		store.respond(store.current()!.id, "deny");
		await expect(next).resolves.toBe("block");
	});
});

describe("PermissionStore subscribers", () => {
	it("notifies subscribers when a request is queued and resolved", async () => {
		const store = new PermissionStore();
		const seen: Array<string | undefined> = [];
		const unsubscribe = store.subscribe((req) => seen.push(req?.tool));

		const promise = store.evaluate("shell", { command: "rm file" });
		expect(seen.at(-1)).toBe("shell");

		store.respond(store.current()!.id, "deny");
		await promise;
		expect(seen.at(-1)).toBeUndefined();

		unsubscribe();
	});

	it("queues multiple requests in FIFO order", async () => {
		const store = new PermissionStore();
		const seen = vi.fn();
		store.subscribe(seen);

		const a = store.evaluate("shell", { command: "rm a" });
		const b = store.evaluate("shell", { command: "rm b" });
		expect(store.current()?.detail).toBe("rm a");

		store.respond(store.current()!.id, "deny");
		await a;
		expect(store.current()?.detail).toBe("rm b");

		store.respond(store.current()!.id, "allow-once");
		await b;
		expect(store.current()).toBeUndefined();
	});

	it("respond() with a stale id is a no-op", () => {
		const store = new PermissionStore();
		const seen = vi.fn();
		store.subscribe(seen);
		store.respond("nonexistent", "allow-once");
		expect(seen).toHaveBeenCalledTimes(1); // only the initial subscribe call
	});
});

describe("PermissionStore request shape", () => {
	it("annotates risk on shell commands", async () => {
		const store = new PermissionStore();
		store.evaluate("shell", { command: "rm -rf node_modules" });
		expect(store.current()?.risk).toBe("high");

		store.respond(store.current()!.id, "deny");
		// pip install isn't in the read-only allowlist so it triggers a prompt.
		store.evaluate("shell", { command: "pip install requests" });
		expect(store.current()?.risk).toBe("medium");
	});

	it("includes a multi-line detail for shell and git_commit", async () => {
		const store = new PermissionStore();
		store.evaluate("shell", { command: "rm -rf dist" });
		expect(store.current()?.detail).toBe("rm -rf dist");

		store.respond(store.current()!.id, "deny");
		store.evaluate("git_commit", { message: "wip: refactor auth" });
		expect(store.current()?.detail).toBe("wip: refactor auth");
	});
});

describe("PermissionStore config patterns", () => {
	it("allow pattern with bare tool name auto-allows that tool", async () => {
		const store = new PermissionStore({ allowPatterns: ["write_file"] });
		await expect(store.evaluate("write_file", { path: "x.ts" })).resolves.toBe("allow");
		// other tools still prompt
		const p = store.evaluate("edit_file", { path: "y.ts" });
		expect(store.current()?.tool).toBe("edit_file");
		store.respond(store.current()!.id, "deny");
		await expect(p).resolves.toBe("block");
	});

	it("allow pattern with glob matches the primary string arg", async () => {
		const store = new PermissionStore({ allowPatterns: ["shell:git status*"] });
		await expect(store.evaluate("shell", { command: "git status" })).resolves.toBe("allow");
		await expect(store.evaluate("shell", { command: "git status --short" })).resolves.toBe("allow");
		// non-matching shell still prompts
		const p = store.evaluate("shell", { command: "rm -rf dist" });
		expect(store.current()?.tool).toBe("shell");
		store.respond(store.current()!.id, "deny");
		await expect(p).resolves.toBe("block");
	});

	it("deny pattern blocks even on a normally-auto-allowed tool", async () => {
		const store = new PermissionStore({ denyPatterns: ["read_file:.env*"] });
		// .env is typically auto-allowed since read_file is read-only.
		await expect(store.evaluate("read_file", { path: ".env" })).resolves.toBe("block");
		await expect(store.evaluate("read_file", { path: ".env.local" })).resolves.toBe("block");
		// regular reads still go through.
		await expect(store.evaluate("read_file", { path: "src/main.ts" })).resolves.toBe("allow");
	});

	it("deny takes priority over allow for the same tool", async () => {
		const store = new PermissionStore({
			allowPatterns: ["shell:*"],
			denyPatterns: ["shell:rm*"],
		});
		await expect(store.evaluate("shell", { command: "ls -la" })).resolves.toBe("allow");
		await expect(store.evaluate("shell", { command: "rm -rf node_modules" })).resolves.toBe("block");
	});

	it("file-path glob matches read/write/edit primary arg", async () => {
		const store = new PermissionStore({ allowPatterns: ["write_file:src/**"] });
		await expect(store.evaluate("write_file", { path: "src/main.ts", content: "" })).resolves.toBe("allow");
		await expect(store.evaluate("write_file", { path: "src/foo/bar.ts", content: "" })).resolves.toBe("allow");
		// outside src/ still prompts
		const p = store.evaluate("write_file", { path: "tests/foo.ts", content: "" });
		expect(store.current()?.tool).toBe("write_file");
		store.respond(store.current()!.id, "deny");
		await expect(p).resolves.toBe("block");
	});

	it("URL glob matches web_fetch", async () => {
		const store = new PermissionStore({ allowPatterns: ["web_fetch:https://docs.codebase.design/*"] });
		await expect(store.evaluate("web_fetch", { url: "https://docs.codebase.design/getting-started" })).resolves.toBe(
			"allow",
		);
	});
});
