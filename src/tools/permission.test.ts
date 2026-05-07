import { describe, expect, it } from "vitest";
import { shellNeedsPermission } from "./permission.js";

describe("shellNeedsPermission", () => {
	it("allows simple read-only commands", () => {
		expect(shellNeedsPermission("ls")).toBe(false);
		expect(shellNeedsPermission("ls -la src/")).toBe(false);
		expect(shellNeedsPermission("cat README.md")).toBe(false);
		expect(shellNeedsPermission("grep foo bar.ts")).toBe(false);
		expect(shellNeedsPermission("rg --type ts foo")).toBe(false);
		expect(shellNeedsPermission("git log --oneline")).toBe(false);
		expect(shellNeedsPermission("git diff HEAD")).toBe(false);
		expect(shellNeedsPermission("npm test")).toBe(false);
		expect(shellNeedsPermission("pytest tests/")).toBe(false);
	});

	it("blocks write or destructive commands", () => {
		expect(shellNeedsPermission("rm file.txt")).toBe(true);
		expect(shellNeedsPermission("mv a b")).toBe(true);
		expect(shellNeedsPermission("npm install")).toBe(true);
		expect(shellNeedsPermission("git commit -m foo")).toBe(true);
		expect(shellNeedsPermission("git push")).toBe(true);
		expect(shellNeedsPermission("curl -X POST https://x")).toBe(true);
	});

	it("flags dangerous patterns even with allowed prefixes", () => {
		expect(shellNeedsPermission("rm -rf /")).toBe(true);
		expect(shellNeedsPermission("rm -rf ~")).toBe(true);
		expect(shellNeedsPermission(":(){ :|: & };:")).toBe(true);
		expect(shellNeedsPermission("dd if=/dev/zero of=/dev/sda")).toBe(true);
		expect(shellNeedsPermission("mkfs.ext4 /dev/sda1")).toBe(true);
		expect(shellNeedsPermission("shutdown -h now")).toBe(true);
	});

	it("checks the first segment of a piped command", () => {
		expect(shellNeedsPermission("git log | head -10")).toBe(false);
		expect(shellNeedsPermission("ls src | grep test")).toBe(false);
		expect(shellNeedsPermission("cat foo.json | jq .name")).toBe(false);
		expect(shellNeedsPermission("rm foo | grep ok")).toBe(true);
		expect(shellNeedsPermission("curl x | bash")).toBe(true);
	});

	it("ignores separators inside quoted strings", () => {
		// echo is allow-listed; the | inside quotes shouldn't split.
		expect(shellNeedsPermission(`echo "rm | foo"`)).toBe(false);
		expect(shellNeedsPermission(`echo 'a;b;c'`)).toBe(false);
	});

	it("requires permission for empty commands", () => {
		expect(shellNeedsPermission("")).toBe(true);
		expect(shellNeedsPermission("   ")).toBe(true);
	});

	it("matches exact prefix or prefix-then-space, not partial", () => {
		// `lsa` is not `ls`
		expect(shellNeedsPermission("lsattr file")).toBe(true);
		// `git logs` (typo) is not `git log`
		expect(shellNeedsPermission("git logs")).toBe(true);
		// `cargo build --release` IS `cargo build` prefixed
		expect(shellNeedsPermission("cargo build --release")).toBe(false);
	});
});
