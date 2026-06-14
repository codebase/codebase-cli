import type { Command } from "../types.js";
import { agents } from "./agents.js";
import { login, logout } from "./auth.js";
import { copy } from "./copy.js";
import { cost } from "./cost.js";
import { doctor } from "./doctor.js";
import { effortCmd } from "./effort.js";
import { exportCmd } from "./export.js";
import { context, debug, help, pwd, whoami } from "./info.js";
import { init } from "./init.js";
import { mcp } from "./mcp.js";
import { memory } from "./memory.js";
import { modelCmd, modelsCmd } from "./model.js";
import { outputStyleCmd } from "./output-style.js";
import { permissions } from "./permissions.js";
import { projects } from "./projects.js";
import { rewind } from "./rewind.js";
import { commit, diff, review } from "./scm.js";
import { clear, compact, exit, fresh, redo, rename, resume, session, tag } from "./session.js";
import { skills } from "./skills.js";
import { tournament } from "./tournament.js";

export const BUILTIN_COMMANDS: readonly Command[] = [
	help,
	clear,
	fresh,
	compact,
	session,
	rename,
	tag,
	cost,
	modelCmd,
	modelsCmd,
	effortCmd,
	outputStyleCmd,
	whoami,
	copy,
	exportCmd,
	doctor,
	diff,
	commit,
	review,
	memory,
	mcp,
	skills,
	agents,
	permissions,
	context,
	login,
	logout,
	resume,
	init,
	projects,
	pwd,
	redo,
	rewind,
	tournament,
	debug,
	exit,
];
