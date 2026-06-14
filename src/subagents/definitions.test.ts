import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXPLORE_TOOLS, GENERAL_TOOLS, loadSubagentDefinitions } from "./definitions.js";

describe("loadSubagentDefinitions", () => {
	let home: string;
	let cwd: string;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "agents-home-"));
		cwd = mkdtempSync(join(tmpdir(), "agents-cwd-"));
	});
	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	});

	function writeAgent(root: string, name: string, content: string): void {
		const dir = join(root, ".codebase", "agents");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, `${name}.md`), content);
	}

	it("always provides the explore and general builtins", () => {
		const defs = loadSubagentDefinitions({ home, cwd });
		expect(defs.map((d) => d.name)).toEqual(["explore", "general"]);
		expect(defs[0].tools).toEqual(EXPLORE_TOOLS);
		expect(defs[1].tools).toEqual(GENERAL_TOOLS);
	});

	it("explore has no write tools; general has them", () => {
		expect(EXPLORE_TOOLS).not.toContain("edit_file");
		expect(EXPLORE_TOOLS).not.toContain("shell");
		expect(GENERAL_TOOLS).toContain("edit_file");
		expect(GENERAL_TOOLS).toContain("shell");
		// Never grantable to any subagent:
		expect(GENERAL_TOOLS).not.toContain("dispatch_agent");
		expect(GENERAL_TOOLS).not.toContain("ask_user");
	});

	it("loads a custom agent with frontmatter tools + role prompt", () => {
		writeAgent(
			home,
			"security-reviewer",
			"---\ndescription: Hunts vulns.\ntools: read_file, grep, glob\n---\nYou are a security reviewer.",
		);
		const defs = loadSubagentDefinitions({ home, cwd });
		const custom = defs.find((d) => d.name === "security-reviewer");
		expect(custom).toMatchObject({
			source: "user",
			description: "Hunts vulns.",
			tools: ["read_file", "grep", "glob"],
		});
		expect(custom?.prompt).toContain("security reviewer");
	});

	it("defaults a custom agent without a tools field to the general set", () => {
		writeAgent(home, "worker", "Do work.");
		const defs = loadSubagentDefinitions({ home, cwd });
		expect(defs.find((d) => d.name === "worker")?.tools).toEqual(GENERAL_TOOLS);
	});

	it("drops tools that aren't subagent-allowed", () => {
		writeAgent(home, "sneaky", "---\ntools: read_file, dispatch_agent, ask_user\n---\nbody");
		const defs = loadSubagentDefinitions({ home, cwd });
		expect(defs.find((d) => d.name === "sneaky")?.tools).toEqual(["read_file"]);
	});

	it("project definitions shadow user definitions with the same name", () => {
		writeAgent(home, "reviewer", "---\ndescription: user version\n---\nu");
		writeAgent(cwd, "reviewer", "---\ndescription: project version\n---\np");
		const defs = loadSubagentDefinitions({ home, cwd });
		const reviewer = defs.find((d) => d.name === "reviewer");
		expect(reviewer?.source).toBe("project");
		expect(reviewer?.description).toBe("project version");
	});

	it("refuses to override a builtin", () => {
		writeAgent(cwd, "general", "---\ndescription: hijacked\n---\nevil");
		const defs = loadSubagentDefinitions({ home, cwd });
		const general = defs.find((d) => d.name === "general");
		expect(general?.source).toBe("builtin");
		expect(general?.tools).toEqual(GENERAL_TOOLS);
	});

	it("skips files with invalid names", () => {
		writeAgent(home, "Bad Name!", "body");
		const defs = loadSubagentDefinitions({ home, cwd });
		expect(defs).toHaveLength(2); // just the builtins
	});

	it("parses model / effort / max_turns frontmatter overrides", () => {
		writeAgent(
			cwd,
			"triage",
			"---\ndescription: fast triage\nmodel: fast-model\neffort: high\nmax_turns: 40\n---\nrole",
		);
		const def = loadSubagentDefinitions({ home, cwd }).find((d) => d.name === "triage");
		expect(def?.model).toBe("fast-model");
		expect(def?.effort).toBe("high");
		expect(def?.maxTurns).toBe(40);
	});

	it("ignores an invalid effort and out-of-range max_turns", () => {
		writeAgent(cwd, "bad", "---\ndescription: x\neffort: ludicrous\nmax_turns: 999\n---\nrole");
		const def = loadSubagentDefinitions({ home, cwd }).find((d) => d.name === "bad");
		expect(def?.effort).toBeUndefined();
		expect(def?.maxTurns).toBeUndefined();
	});

	it("leaves overrides undefined when frontmatter omits them", () => {
		writeAgent(cwd, "plain", "---\ndescription: x\n---\nrole");
		const def = loadSubagentDefinitions({ home, cwd }).find((d) => d.name === "plain");
		expect(def?.model).toBeUndefined();
		expect(def?.effort).toBeUndefined();
		expect(def?.maxTurns).toBeUndefined();
	});
});
