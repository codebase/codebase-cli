import { describe, expect, it } from "vitest";
import { commandPrefix } from "./command-prefix.js";

describe("commandPrefix", () => {
	it("keeps binary + subcommand for subcommand-style tools", () => {
		expect(commandPrefix('git commit -m "wip"')).toBe("git commit");
		expect(commandPrefix("npm run build")).toBe("npm run");
		expect(commandPrefix("cargo test --all")).toBe("cargo test");
		expect(commandPrefix("docker compose up -d")).toBe("docker compose");
	});

	it("keeps just the binary for plain commands", () => {
		expect(commandPrefix("ls -la")).toBe("ls");
		expect(commandPrefix("python script.py")).toBe("python");
		expect(commandPrefix("cat /etc/hosts")).toBe("cat");
	});

	it("takes only the first command of a compound", () => {
		expect(commandPrefix("git add . && git commit -m x")).toBe("git add");
		expect(commandPrefix("make build; make test")).toBe("make build");
		expect(commandPrefix("cat foo | grep bar")).toBe("cat");
	});

	it("strips leading env assignments and bare wrappers", () => {
		expect(commandPrefix("FOO=bar npm run dev")).toBe("npm run");
		expect(commandPrefix("sudo systemctl restart nginx")).toBe("systemctl restart");
		expect(commandPrefix("env cargo build")).toBe("cargo build");
	});

	it("strips a directory path from the binary", () => {
		expect(commandPrefix("/usr/bin/git status")).toBe("git status");
		expect(commandPrefix("./scripts/deploy.sh")).toBe("deploy.sh");
	});

	it("does not attach a flag as a subcommand", () => {
		expect(commandPrefix("git --version")).toBe("git");
		expect(commandPrefix("npm -v")).toBe("npm");
	});

	it("returns null for empty / whitespace", () => {
		expect(commandPrefix("")).toBeNull();
		expect(commandPrefix("   ")).toBeNull();
	});
});
