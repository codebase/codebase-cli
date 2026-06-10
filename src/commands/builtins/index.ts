import type { Command } from "../types.js";
import { login, logout } from "./auth.js";
import { copy } from "./copy.js";
import { cost } from "./cost.js";
import { context, debug, help, pwd, whoami } from "./info.js";
import { init } from "./init.js";
import { mcp } from "./mcp.js";
import { memory } from "./memory.js";
import { modelCmd, modelsCmd } from "./model.js";
import { outputStyleCmd } from "./output-style.js";
import { projects } from "./projects.js";
import { commit, diff, review } from "./scm.js";
import { clear, compact, exit, fresh, redo, resume, session } from "./session.js";

export const BUILTIN_COMMANDS: readonly Command[] = [
	help,
	clear,
	fresh,
	compact,
	session,
	cost,
	modelCmd,
	modelsCmd,
	outputStyleCmd,
	whoami,
	copy,
	diff,
	commit,
	review,
	memory,
	mcp,
	context,
	login,
	logout,
	resume,
	init,
	projects,
	pwd,
	redo,
	debug,
	exit,
];
