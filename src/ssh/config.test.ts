import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSshConfig } from "./config.js";

describe("loadSshConfig", () => {
	let home: string;
	let cwd: string;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "codebase-ssh-home-"));
		cwd = mkdtempSync(join(tmpdir(), "codebase-ssh-cwd-"));
	});

	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	});

	function writeUserConfig(body: unknown): void {
		mkdirSync(join(home, ".codebase"), { recursive: true });
		writeFileSync(join(home, ".codebase", "ssh.json"), JSON.stringify(body));
	}

	function writeProjectConfig(body: unknown): void {
		mkdirSync(join(cwd, ".codebase"), { recursive: true });
		writeFileSync(join(cwd, ".codebase", "ssh.json"), JSON.stringify(body));
	}

	it("returns empty config when no files exist", () => {
		const cfg = loadSshConfig({ home, cwd });
		expect(cfg.hosts).toEqual([]);
	});

	it("loads a minimal host from the user config", () => {
		writeUserConfig({ hosts: [{ name: "staging", host: "staging.example.com" }] });
		const cfg = loadSshConfig({ home, cwd });
		expect(cfg.hosts).toHaveLength(1);
		expect(cfg.get("staging")).toEqual({ name: "staging", host: "staging.example.com" });
	});

	it("loads optional fields user/port/identityFile/description", () => {
		writeUserConfig({
			hosts: [
				{
					name: "prod",
					host: "prod.example.com",
					user: "deploy",
					port: 2222,
					identityFile: "~/.codebase/ssh/prod",
					description: "production",
				},
			],
		});
		const cfg = loadSshConfig({ home, cwd });
		const h = cfg.get("prod");
		expect(h?.user).toBe("deploy");
		expect(h?.port).toBe(2222);
		expect(h?.identityFile).toBe("~/.codebase/ssh/prod");
		expect(h?.description).toBe("production");
	});

	it("project config overrides user config on name conflict", () => {
		writeUserConfig({ hosts: [{ name: "x", host: "user-host" }] });
		writeProjectConfig({ hosts: [{ name: "x", host: "project-host" }] });
		const cfg = loadSshConfig({ home, cwd });
		expect(cfg.hosts).toHaveLength(1);
		expect(cfg.get("x")?.host).toBe("project-host");
	});

	it("merges non-conflicting hosts from both sources", () => {
		writeUserConfig({ hosts: [{ name: "a", host: "a.example" }] });
		writeProjectConfig({ hosts: [{ name: "b", host: "b.example" }] });
		const cfg = loadSshConfig({ home, cwd });
		const names = cfg.hosts.map((h) => h.name).sort();
		expect(names).toEqual(["a", "b"]);
	});

	it("rejects host entries with invalid name patterns", () => {
		writeUserConfig({
			hosts: [
				{ name: "good", host: "good.example" },
				{ name: "Has Spaces", host: "x" },
				{ name: "../etc", host: "x" },
				{ name: "", host: "x" },
			],
		});
		const cfg = loadSshConfig({ home, cwd });
		expect(cfg.hosts.map((h) => h.name)).toEqual(["good"]);
	});

	it("rejects hosts smuggled as user@host:port strings in the host field", () => {
		writeUserConfig({
			hosts: [
				{ name: "sneaky1", host: "root@target.example" },
				{ name: "sneaky2", host: "target.example:22" },
				{ name: "sneaky3", host: "target with space" },
				{ name: "clean", host: "target.example" },
			],
		});
		const cfg = loadSshConfig({ home, cwd });
		expect(cfg.hosts.map((h) => h.name)).toEqual(["clean"]);
	});

	it("rejects malformed port values", () => {
		writeUserConfig({
			hosts: [
				{ name: "low", host: "x", port: 0 },
				{ name: "high", host: "x", port: 70_000 },
				{ name: "neg", host: "x", port: -1 },
				{ name: "ok", host: "x", port: 22 },
			],
		});
		const cfg = loadSshConfig({ home, cwd });
		expect(cfg.hosts.map((h) => h.name)).toEqual(["ok"]);
	});

	it("returns empty config when the file is malformed JSON (logs to stderr)", () => {
		mkdirSync(join(home, ".codebase"), { recursive: true });
		writeFileSync(join(home, ".codebase", "ssh.json"), "{not json");
		const cfg = loadSshConfig({ home, cwd });
		expect(cfg.hosts).toEqual([]);
	});

	it("returns empty when top-level hosts is missing", () => {
		writeUserConfig({ wrong: [] });
		const cfg = loadSshConfig({ home, cwd });
		expect(cfg.hosts).toEqual([]);
	});
});
