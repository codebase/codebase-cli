import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ActivityLog, agreementRate } from "./activity.js";

describe("ActivityLog", () => {
	let root: string;
	let log: ActivityLog;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "dir-activity-"));
		log = new ActivityLog({ cwd: "/some/project", slug: "marketing", dataRoot: root });
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	function ev(
		kind: Parameters<typeof log.append>[0]["kind"],
		family: string,
		rev: "reversible" | "irreversible" = "reversible",
	) {
		return log.append({ kind, tool: "shell", summary: `${kind} ${family}`, rev, risk: "low", family, ts: 1 });
	}

	it("appends and reads back in order", () => {
		ev("auto-approved", "git commit");
		ev("approved", "git push", "irreversible");
		const all = log.read();
		expect(all).toHaveLength(2);
		expect(all[0].kind).toBe("auto-approved");
		expect(all[1].family).toBe("git push");
	});

	it("returns [] when nothing logged", () => {
		expect(log.read()).toEqual([]);
		expect(log.stats().total).toBe(0);
	});

	it("computes graduation stats: counts, irreversible denials, per-family agreement", () => {
		ev("auto-approved", "git commit");
		ev("auto-approved", "git commit");
		ev("approved", "git push", "irreversible");
		ev("approved", "git push", "irreversible");
		ev("denied", "git push", "irreversible");
		ev("escalated", "kubectl delete", "irreversible");

		const s = log.stats();
		expect(s).toMatchObject({
			total: 6,
			autoApproved: 2,
			escalated: 1,
			approved: 2,
			denied: 1,
			deniedIrreversible: 1,
		});
		// 2 approved of 3 judged on git push.
		expect(s.byFamily["git push"]).toEqual({ proposed: 3, approved: 2 });
		expect(agreementRate(s.byFamily["git push"])).toBeCloseTo(2 / 3);
		// auto-approved + escalated don't enter byFamily (no human judgement).
		expect(s.byFamily["git commit"]).toBeUndefined();
		expect(s.byFamily["kubectl delete"]).toBeUndefined();
	});

	it("agreementRate is null with no judged proposals", () => {
		expect(agreementRate({ proposed: 0, approved: 0 })).toBeNull();
	});

	it("tolerates a torn final line from a crash mid-append", () => {
		ev("approved", "git push");
		// Simulate a half-written trailing record from a crash mid-append.
		const path = (log as unknown as { path: string }).path;
		appendFileSync(path, '{"ts":2,"kind":"approv', "utf8");
		expect(log.read()).toHaveLength(1);
		expect(log.stats().approved).toBe(1);
	});

	it("scopes the log per-project (different cwd → different file)", () => {
		ev("approved", "git push");
		const other = new ActivityLog({ cwd: "/other/project", slug: "marketing", dataRoot: root });
		expect(other.read()).toEqual([]);
	});
});
