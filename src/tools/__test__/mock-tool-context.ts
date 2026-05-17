/**
 * Typed factory for a ToolContext suitable for unit tests. Uses real
 * instances of the in-memory stores (they're cheap to construct) so
 * tests catch interface-shape drift the moment a field is added to
 * ToolContext — previously this was `{} as any` for every field, which
 * meant adding a new required member to ToolContext compiled green
 * while every test was secretly missing it.
 */

import { MemoryStore } from "../../memory/store.js";
import { PlanModeStore } from "../../plan/store.js";
import { UserQueryStore } from "../../user-queries/store.js";
import { BackgroundShellStore } from "../background-shell-store.js";
import { FileStateCache } from "../file-state-cache.js";
import { MonitorStore } from "../monitor-store.js";
import { TaskStore } from "../task-store.js";
import type { ToolContext } from "../types.js";

export function makeMockToolContext(cwd: string): ToolContext {
	const backgroundShells = new BackgroundShellStore();
	return {
		cwd,
		fileStateCache: new FileStateCache(),
		tasks: new TaskStore(),
		userQueries: new UserQueryStore(),
		planMode: new PlanModeStore(),
		memory: new MemoryStore({ cwd }),
		backgroundShells,
		monitors: new MonitorStore(backgroundShells),
		// spawnSubagent is the only field a test can't supply a real
		// implementation for (it depends on the live agent factory).
		// We throw to make the boundary explicit: any test that calls a
		// subagent-spawning tool needs to provide its own stub.
		spawnSubagent: () => {
			throw new Error("mock-tool-context: spawnSubagent not stubbed — provide one in the test if you need it");
		},
	};
}
