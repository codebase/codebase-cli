import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, ConfigStore, mergeConfig } from "./store.js";

describe("ConfigStore", () => {
	let home: string;
	let cwd: string;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "config-home-"));
		cwd = mkdtempSync(join(tmpdir(), "config-cwd-"));
	});

	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	});

	function writeUserConfig(content: object) {
		mkdirSync(join(home, ".codebase"), { recursive: true });
		writeFileSync(join(home, ".codebase", "config.json"), JSON.stringify(content));
	}

	function writeProjectConfig(content: object) {
		mkdirSync(join(cwd, ".codebase"), { recursive: true });
		writeFileSync(join(cwd, ".codebase", "config.json"), JSON.stringify(content));
	}

	function writeLocalConfig(content: object) {
		mkdirSync(join(home, ".codebase"), { recursive: true });
		writeFileSync(join(home, ".codebase", "config.local.json"), JSON.stringify(content));
	}

	it("returns an empty config when no files exist", () => {
		const store = new ConfigStore({ home, cwd });
		expect(store.load()).toEqual({});
		expect(store.allowPatterns()).toEqual([]);
	});

	it("reads the user config", () => {
		writeUserConfig({ permissions: { allow: ["list_files"] } });
		const store = new ConfigStore({ home, cwd });
		expect(store.allowPatterns()).toEqual(["list_files"]);
	});

	it("project config concatenates with user config for permissions.allow", () => {
		writeUserConfig({ permissions: { allow: ["list_files"] } });
		writeProjectConfig({ permissions: { allow: ["shell:git status*"] } });
		const store = new ConfigStore({ home, cwd });
		expect(store.allowPatterns()).toEqual(["list_files", "shell:git status*"]);
	});

	it("local config layers on top, additively", () => {
		writeUserConfig({ permissions: { allow: ["list_files"] } });
		writeProjectConfig({ permissions: { allow: ["read_file:src/**"] } });
		writeLocalConfig({ permissions: { allow: ["shell:npm test*"] } });
		const store = new ConfigStore({ home, cwd });
		expect(store.allowPatterns()).toEqual(["list_files", "read_file:src/**", "shell:npm test*"]);
	});

	it("de-dupes identical patterns across layers", () => {
		writeUserConfig({ permissions: { allow: ["list_files", "shell:git status"] } });
		writeProjectConfig({ permissions: { allow: ["shell:git status"] } });
		const store = new ConfigStore({ home, cwd });
		expect(store.allowPatterns()).toEqual(["list_files", "shell:git status"]);
	});

	it("scalars at the top level are replaced (not merged)", () => {
		writeUserConfig({ theme: "dark" });
		writeProjectConfig({ theme: "light" });
		const store = new ConfigStore({ home, cwd });
		expect((store.load() as { theme: string }).theme).toBe("light");
	});

	it("preserves unknown keys (forward-compat)", () => {
		writeUserConfig({ futureFeature: { enabled: true, ratio: 0.5 } });
		const store = new ConfigStore({ home, cwd });
		expect(store.load().futureFeature).toEqual({ enabled: true, ratio: 0.5 });
	});

	it("malformed JSON throws ConfigError with the path", () => {
		mkdirSync(join(home, ".codebase"), { recursive: true });
		writeFileSync(join(home, ".codebase", "config.json"), "{ not valid json");
		const store = new ConfigStore({ home, cwd });
		expect(() => store.load()).toThrow(ConfigError);
		expect(() => store.load()).toThrow(/config\.json/);
	});

	it("non-object top-level throws ConfigError", () => {
		mkdirSync(join(home, ".codebase"), { recursive: true });
		writeFileSync(join(home, ".codebase", "config.json"), JSON.stringify(["array", "is", "wrong"]));
		const store = new ConfigStore({ home, cwd });
		expect(() => store.load()).toThrow(ConfigError);
	});

	it("invalidate() forces re-read on next load", () => {
		writeUserConfig({ permissions: { allow: ["a"] } });
		const store = new ConfigStore({ home, cwd });
		expect(store.allowPatterns()).toEqual(["a"]);
		writeUserConfig({ permissions: { allow: ["a", "b"] } });
		expect(store.allowPatterns()).toEqual(["a"]); // still cached
		store.invalidate();
		expect(store.allowPatterns()).toEqual(["a", "b"]);
	});
});

describe("mergeConfig", () => {
	it("concatenates permissions.allow from both layers", () => {
		const base = { permissions: { allow: ["x"] } };
		const overlay = { permissions: { allow: ["y"] } };
		expect(mergeConfig(base, overlay).permissions?.allow).toEqual(["x", "y"]);
	});

	it("preserves base.allow when overlay has only deny", () => {
		const base = { permissions: { allow: ["x"] } };
		const overlay = { permissions: { deny: ["y"] } };
		const out = mergeConfig(base, overlay);
		expect(out.permissions?.allow).toEqual(["x"]);
		expect(out.permissions?.deny).toEqual(["y"]);
	});

	it("preserves overlay.allow when base has none", () => {
		const base = {};
		const overlay = { permissions: { allow: ["x"] } };
		expect(mergeConfig(base, overlay).permissions?.allow).toEqual(["x"]);
	});
});
