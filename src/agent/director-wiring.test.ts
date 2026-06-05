import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxProviderRegistration, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Director } from "../directors/types.js";
import { PermissionStore } from "../permissions/store.js";
import { createAgent, permissionGate } from "./agent.js";

/**
 * Proves the run-as-director wiring end-to-end: a Director passed to
 * createAgent must (1) feed its autonomy into the permission gate and
 * (2) carry its trusted allow-list. The mapping itself is unit-tested in
 * directors/store.test.ts; this checks the composition inside createAgent.
 */
function makeDirector(over: Partial<Director> = {}): Director {
	return {
		slug: "marketing",
		name: "Director of Marketing",
		mandate: "Own the launch",
		autonomy: "autonomous",
		trusts: ["shell:git push origin marketing*"],
		handbook: "Punchy, no hype.",
		...over,
	};
}

describe("createAgent — running as a director", () => {
	let cwd: string;
	let faux: FauxProviderRegistration;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "director-wire-"));
		faux = registerFauxProvider({
			models: [
				{
					id: "test-model",
					name: "Test Model",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 100_000,
					maxTokens: 4096,
				},
			],
			tokenSize: { min: 1, max: 2 },
		});
	});
	afterEach(() => {
		faux.unregister();
		rmSync(cwd, { recursive: true, force: true });
	});

	function bundleFor(director: Director) {
		return createAgent({
			cwd,
			configOverride: { model: faux.getModel(), apiKey: "test-key", source: "explicit" },
			director,
		});
	}

	it("acts on routine work but the gate blocks un-trusted destructive ops", async () => {
		const { permissions } = bundleFor(makeDirector());
		expect(await permissions.evaluate("shell", { command: "ls -la" })).toBe("allow"); // routine
		expect(await permissions.evaluate("write_file", { path: "x.ts" })).toBe("allow"); // building
		expect(await permissions.evaluate("shell", { command: "rm -rf /" })).toBe("block"); // gated
	});

	it("honors the director's trusted allow-list for a normally-gated op", async () => {
		const { permissions } = bundleFor(makeDirector());
		expect(await permissions.evaluate("shell", { command: "git push origin marketing-x" })).toBe("allow");
	});

	it("a cautious director never auto-approves — mutating tools still prompt", () => {
		const { permissions } = bundleFor(makeDirector({ autonomy: "cautious" }));
		const p = permissions.evaluate("write_file", { path: "x.ts" });
		expect(permissions.current()?.tool).toBe("write_file"); // queued for a human, not auto-allowed
		permissions.respond(permissions.current()?.id ?? "", "deny");
		return expect(p).resolves.toBe("block");
	});
});

describe("permissionGate (shared by the main agent + every spawned worker)", () => {
	it("passes through what the store allows and blocks what it gates", async () => {
		const gate = permissionGate(new PermissionStore({ autoApprove: true }));
		expect(await gate("shell", { command: "ls -la" })).toBeUndefined(); // routine → no block
		expect(await gate("write_file", { path: "x.ts" })).toBeUndefined(); // building → no block
		expect(await gate("shell", { command: "rm -rf /" })).toMatchObject({ block: true }); // irreversible → blocked
	});
});
