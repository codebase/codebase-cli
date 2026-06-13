import { describe, expect, it } from "vitest";
import { CopyRegistry } from "./copy-targets.js";

describe("CopyRegistry", () => {
	it("registers and reads back box text", () => {
		const reg = new CopyRegistry();
		const id = reg.register("msg-0:b0", "bash", "npm run build");
		expect(reg.get(id)?.text).toBe("npm run build");
		expect(reg.get(id)?.label).toBe("bash");
	});

	it("keeps a stable id per key across re-renders, updating text", () => {
		const reg = new CopyRegistry();
		const a = reg.register("k", "bash", "v1");
		const b = reg.register("k", "bash", "v2");
		expect(a).toBe(b);
		expect(reg.get(a)?.text).toBe("v2");
		expect(reg.list()).toHaveLength(1);
	});

	it("lists distinct boxes in registration order", () => {
		const reg = new CopyRegistry();
		reg.register("a", "bash", "one");
		reg.register("b", "key", "two");
		expect(reg.list().map((e) => e.text)).toEqual(["one", "two"]);
	});
});
