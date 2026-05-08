import { describe, expect, it, vi } from "vitest";
import { PlanModeStore } from "./store.js";

describe("PlanModeStore", () => {
	it("starts inactive", () => {
		const store = new PlanModeStore();
		expect(store.isActive()).toBe(false);
	});

	it("toggles active on enter/exit", () => {
		const store = new PlanModeStore();
		store.enter();
		expect(store.isActive()).toBe(true);
		store.exit();
		expect(store.isActive()).toBe(false);
	});

	it("repeated enter() does not re-notify subscribers", () => {
		const store = new PlanModeStore();
		const listener = vi.fn();
		store.subscribe(listener);
		listener.mockClear();
		store.enter();
		store.enter();
		store.enter();
		expect(listener).toHaveBeenCalledTimes(1);
		expect(listener).toHaveBeenCalledWith(true);
	});

	it("subscribe immediately fires with current state", () => {
		const store = new PlanModeStore();
		store.enter();
		const listener = vi.fn();
		store.subscribe(listener);
		expect(listener).toHaveBeenCalledWith(true);
	});

	it("unsubscribe stops further notifications", () => {
		const store = new PlanModeStore();
		const listener = vi.fn();
		const off = store.subscribe(listener);
		listener.mockClear();
		off();
		store.enter();
		expect(listener).not.toHaveBeenCalled();
	});
});
