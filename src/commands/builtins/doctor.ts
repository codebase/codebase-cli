import { buildDoctorReport } from "../../diagnostics/doctor.js";
import type { Command } from "../types.js";

/**
 * /doctor — diagnose the install: runtime, credentials, config files,
 * MCP servers, search keys, storage. Each check is one ✓/✗/– line so a
 * support request can start with a paste of this output.
 */
export const doctor: Command = {
	name: "doctor",
	description: "Diagnose the installation: runtime, auth, config, MCP, storage.",
	handler: (_args, ctx) => {
		ctx.emit(
			buildDoctorReport({
				cwd: ctx.bundle.toolContext.cwd,
				model: ctx.state.model,
				source: ctx.bundle.source,
				mcpStatuses: ctx.bundle.mcp.status(),
				sessionCount: ctx.bundle.sessions.list().length,
				subagentTypes: ctx.bundle.toolContext.subagentTypes,
			}).join("\n"),
		);
		return { handled: true };
	},
};
