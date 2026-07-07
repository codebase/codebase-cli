import { describe, expect, it } from "vitest";
import { classifyReversibility, type Reversibility } from "./reversibility.js";

function rev(tool: string, args?: unknown): Reversibility {
	return classifyReversibility(tool, args).rev;
}
function shell(command: string): Reversibility {
	return classifyReversibility("shell", { command }).rev;
}

describe("classifyReversibility — tools", () => {
	it("read-only tools are reversible/low", () => {
		for (const t of ["read_file", "grep", "glob", "git_diff", "web_search", "read_mcp_resource", "ask_user"]) {
			const ver = classifyReversibility(t, {});
			expect(ver.rev).toBe("reversible");
			expect(ver.risk).toBe("low");
		}
	});

	it("checkpointed file writes are REVERSIBLE — the regex's biggest false positive", () => {
		// Even an overwrite: withCheckpoint snapshots the pre-image, /rewind restores it.
		for (const t of ["write_file", "edit_file", "multi_edit", "notebook_edit"]) {
			expect(rev(t, { path: "src/x.ts" })).toBe("reversible");
		}
	});

	it("local session/git mutations are reversible", () => {
		for (const t of ["git_commit", "git_branch", "save_memory", "create_task", "dispatch_agent"]) {
			expect(rev(t, {})).toBe("reversible");
		}
	});

	it("ssh_exec and channel_send are always irreversible", () => {
		expect(classifyReversibility("ssh_exec", { host: "prod", command: "ls" })).toMatchObject({
			rev: "irreversible",
			risk: "high",
		});
		expect(rev("channel_send", { to: "me@x.com", body: "hi" })).toBe("irreversible");
	});

	it("an unrecognized tool is unknown (escalates by default)", () => {
		expect(rev("frobnicate", {})).toBe("unknown");
	});
});

describe("classifyReversibility — shell", () => {
	it("hard-block destructive patterns are irreversible/high", () => {
		expect(classifyReversibility("shell", { command: "rm -rf /" })).toMatchObject({
			rev: "irreversible",
			risk: "high",
		});
		expect(shell("dd if=/dev/zero of=/dev/sda")).toBe("irreversible");
		expect(shell("mkfs.ext4 /dev/sdb")).toBe("irreversible");
		expect(shell(":(){ :|:& };:")).toBe("irreversible");
	});

	it("irreversible command families escalate", () => {
		for (const c of [
			"git push origin main",
			"rm somefile.txt",
			"git reset --hard HEAD~3",
			"kubectl delete pod web",
			"terraform apply",
			"helm uninstall app",
			"npm publish",
			"docker push acme/app:latest",
		]) {
			expect(shell(c)).toBe("irreversible");
		}
	});

	it("read-only shell commands are reversible", () => {
		for (const c of ["ls -la", "cat package.json", "git status", "rg TODO", "npm test", "git log --oneline"]) {
			expect(shell(c)).toBe("reversible");
		}
	});

	it("local-mutation shell families are reversible", () => {
		for (const c of ["git commit -m wip", "git checkout -b feature", "mkdir build", "npm install", "git stash"]) {
			expect(shell(c)).toBe("reversible");
		}
	});

	it("ambiguous binaries (aws/gcloud/curl) are unknown — conservatively escalate", () => {
		for (const c of [
			"aws s3 rm s3://bucket/key",
			"gcloud compute instances delete x",
			"curl -X POST https://prod/api",
		]) {
			expect(shell(c)).toBe("unknown");
		}
	});

	it("conservatively flags a destructive substring even when quoted", () => {
		// The existing DANGEROUS_PATTERNS match the literal `rm -rf /` regardless
		// of quoting — a known false-positive that errs toward escalation, which
		// is the safe direction for an unattended gate. We inherit it intentionally.
		expect(shell('echo "rm -rf /"')).toBe("irreversible");
	});

	it("an empty command is unknown", () => {
		expect(shell("   ")).toBe("unknown");
	});
});

describe("classifyReversibility — MCP", () => {
	it("read-verb MCP tools are reversible", () => {
		for (const t of ["mcp__postgres__list_tables", "mcp__fs__read_file", "mcp__gh__search_issues"]) {
			expect(rev(t, {})).toBe("reversible");
		}
	});

	it("write-verb MCP tools are irreversible", () => {
		for (const t of ["mcp__postgres__delete_row", "mcp__stripe__create_charge", "mcp__deploy__deploy_service"]) {
			expect(rev(t, {})).toBe("irreversible");
		}
	});

	it("verbless / unknown MCP tools are unknown", () => {
		expect(rev("mcp__weird__frobnicate", {})).toBe("unknown");
	});
});

describe("Verdict shape", () => {
	it("always returns a non-empty reason", () => {
		for (const [t, a] of [
			["read_file", {}],
			["shell", { command: "git push" }],
			["ssh_exec", {}],
			["mcp__x__delete_thing", {}],
			["frobnicate", {}],
		] as const) {
			expect(classifyReversibility(t, a).reason.length).toBeGreaterThan(0);
		}
	});
});

describe("classifyReversibility — compound shell commands", () => {
	it("does not let a reversible prefix shadow an irreversible tail", () => {
		expect(shell("git commit -am wip && git push")).toBe("irreversible");
		expect(shell("cd repo && terraform apply")).toBe("irreversible");
		expect(shell("echo ok && npm publish")).toBe("irreversible");
		expect(shell("git add -A; git commit -m x && docker push acme/app")).toBe("irreversible");
	});

	it("keeps all-reversible compounds reversible", () => {
		expect(shell("git add -A && git commit -m x")).toBe("reversible");
		expect(shell("mkdir build && cargo build")).toBe("reversible");
	});

	it("escalates when any compound segment is unclassified", () => {
		expect(shell("git commit -m x && curl -X POST https://example.com/hook")).toBe("unknown");
	});
});
