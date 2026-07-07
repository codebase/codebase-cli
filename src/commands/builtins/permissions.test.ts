import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../types.js";
import { permissions } from "./permissions.js";

describe("/permissions", () => {
	let cwd: string;
	let emits: string[];
	let ctx: CommandContext;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "permissions-cwd-"));
		emits = [];
		ctx = {
			emit: (text: string) => emits.push(text),
			bundle: {
				toolContext: { cwd },
				permissions: {
					listTrusted: () => ({ tools: [], shellPrefixes: [] }),
					setRules: vi.fn(),
				},
			},
		} as unknown as CommandContext;
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("explains shell auto-allow and validator policy", () => {
		permissions.handler("shell", ctx);

		expect(emits).toHaveLength(1);
		expect(emits[0]).toContain("Shell permission policy:");
		expect(emits[0]).toContain("auto-allowed read-only prefixes");
		expect(emits[0]).toContain("shell:git commit*");
		expect(emits[0]).toContain("hard blocks:");
		expect(emits[0]).toContain("warnings:");
	});
});
