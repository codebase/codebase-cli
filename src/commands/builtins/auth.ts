import { CredentialsStore } from "../../auth/credentials.js";
import type { Command } from "../types.js";

// ─── auth / session ───────────────────────────────────────────────────

export const login: Command = {
	name: "login",
	description: "Sign in via codebase.design OAuth (run from a fresh terminal: `codebase auth login`).",
	handler: (_args, ctx) => {
		ctx.emit(
			"to sign in, exit (Ctrl-C) and run:\n  codebase auth login\n\n" +
				"that opens your browser to codebase.design and persists tokens to ~/.codebase/credentials.json. " +
				"after sign-in, restart codebase to use the new credentials.",
		);
		return { handled: true };
	},
};

export const logout: Command = {
	name: "logout",
	description: "Clear saved credentials. Restart to take effect.",
	mutates: true,
	handler: (_args, ctx) => {
		const store = new CredentialsStore();
		const cleared = store.clear();
		if (cleared) {
			ctx.emit("cleared ~/.codebase/credentials.json. Restart codebase to use a different provider/sign-in.");
		} else {
			ctx.emit("no saved credentials to clear.");
		}
		return { handled: true };
	},
};
