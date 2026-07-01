import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { ToolExecution } from "../types.js";
import { LiveToolPanel } from "./tool-panel-live.js";

describe("LiveToolPanel", () => {
	it("keeps multiline tool argument previews inside the terminal width", () => {
		const tools = new Map<string, ToolExecution>([
			[
				"write-index",
				{
					id: "write-index",
					name: "write_file",
					args: {
						path: "/private/tmp/codebase-dogfood-workspace.UqP74C/index.html",
						content: '<!DOCTYPE html>\n<html lang="en">\n<head><title>Counter</title></head>',
					},
					status: "running",
					startedAt: Date.now(),
				},
			],
		]);

		const lines = new LiveToolPanel(tools).render(80);

		expect(lines.length).toBeGreaterThan(0);
		for (const line of lines) {
			expect(line).not.toContain("\n");
			expect(visibleWidth(line)).toBeLessThanOrEqual(80);
		}
	});
});
