import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isHeadlessSession } from "./browser-open.js";

/**
 * Headless-session heuristic tests. These run on the dev's machine
 * (which may itself be a non-headless TTY, an SSH session, a CI runner,
 * or a docker container), so we save + restore the env to keep tests
 * deterministic. The fixture only fiddles with the variables the
 * heuristic actually reads.
 */
describe("isHeadlessSession", () => {
	const saved: Record<string, string | undefined> = {};
	const KEYS = ["SSH_CONNECTION", "SSH_TTY", "SSH_CLIENT", "DISPLAY", "WAYLAND_DISPLAY"] as const;

	beforeEach(() => {
		for (const k of KEYS) {
			saved[k] = process.env[k];
			delete process.env[k];
		}
	});

	afterEach(() => {
		for (const k of KEYS) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
	});

	it("returns true when SSH_CONNECTION is set", () => {
		process.env.SSH_CONNECTION = "1.2.3.4 4242 5.6.7.8 22";
		expect(isHeadlessSession()).toBe(true);
	});

	it("returns true when SSH_TTY is set", () => {
		process.env.SSH_TTY = "/dev/pts/0";
		expect(isHeadlessSession()).toBe(true);
	});

	it("returns true when SSH_CLIENT is set", () => {
		process.env.SSH_CLIENT = "1.2.3.4 4242 22";
		expect(isHeadlessSession()).toBe(true);
	});

	it("on linux: returns true with no DISPLAY/WAYLAND_DISPLAY", () => {
		if (process.platform !== "linux") {
			// On macOS/Windows the linux-only branch is unreachable; we
			// just assert the default-false case below covers them.
			return;
		}
		expect(isHeadlessSession()).toBe(true);
	});

	it("on linux: returns false when DISPLAY is set", () => {
		if (process.platform !== "linux") return;
		process.env.DISPLAY = ":0";
		expect(isHeadlessSession()).toBe(false);
	});

	it("on linux: returns false when WAYLAND_DISPLAY is set", () => {
		if (process.platform !== "linux") return;
		process.env.WAYLAND_DISPLAY = "wayland-0";
		expect(isHeadlessSession()).toBe(false);
	});

	it("on macOS / Windows: returns false by default", () => {
		if (process.platform === "linux") return;
		expect(isHeadlessSession()).toBe(false);
	});
});
