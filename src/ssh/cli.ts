import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadSshConfig, type SshHost } from "./config.js";
import { SshStore } from "./store.js";

/**
 * `codebase ssh` subcommand dispatcher.
 *
 *   codebase ssh add <name> <hostname> [--user U] [--port P] [--key PATH] [--desc TEXT]
 *   codebase ssh list
 *   codebase ssh rm <name>
 *   codebase ssh test <name>
 *   codebase ssh keygen <name> [--rsa] [--no-passphrase]
 *
 * Hosts persist to ~/.codebase/ssh.json; the agent's ssh_exec tool
 * reads from there. Project-level overrides live in
 * <cwd>/.codebase/ssh.json — those are hand-edited (no add/rm CLI
 * shortcut yet; project hosts are explicit + reviewable).
 */
export async function runSshSubcommand(argv: readonly string[]): Promise<number> {
	const out = (m: string): void => {
		process.stdout.write(`${m}\n`);
	};
	const err = (m: string): void => {
		process.stderr.write(`${m}\n`);
	};
	const cmd = argv[1];

	if (!cmd || cmd === "--help" || cmd === "-h") {
		printHelp(out);
		return 0;
	}

	const store = new SshStore();

	switch (cmd) {
		case "add":
			return addHost(argv.slice(2), store, out, err);
		case "list":
		case "ls":
			return listHosts(out);
		case "rm":
		case "remove":
			return removeHost(argv.slice(2), store, out, err);
		case "test":
			return testHost(argv.slice(2), out, err);
		case "keygen":
			return keygen(argv.slice(2), out, err);
		default:
			err(`unknown subcommand: ${cmd}. Run \`codebase ssh --help\` for usage.`);
			return 2;
	}
}

function printHelp(out: (m: string) => void): void {
	out("Manage SSH hosts the agent can target via the ssh_exec tool.");
	out("");
	out("Usage:");
	out("  codebase ssh add <name> <hostname> [--user U] [--port P] [--key PATH] [--desc TEXT]");
	out("  codebase ssh list");
	out("  codebase ssh rm <name>");
	out("  codebase ssh test <name>");
	out("  codebase ssh keygen <name> [--rsa] [--no-passphrase]");
	out("");
	out("Security model:");
	out("  Hosts are addressed by name. The agent picks a name from the");
	out("  enrolled set; it cannot construct arbitrary user@host strings.");
	out("  Add only the machines you want the agent reaching.");
	out("");
	out("Config files (merged, project wins on name conflict):");
	out("  ~/.codebase/ssh.json        — user-wide (managed by these commands)");
	out("  <cwd>/.codebase/ssh.json    — project-specific (hand-edit)");
}

function addHost(args: readonly string[], store: SshStore, out: (m: string) => void, err: (m: string) => void): number {
	const [name, hostname, ...rest] = args;
	if (!name || !hostname) {
		err("usage: codebase ssh add <name> <hostname> [--user U] [--port P] [--key PATH] [--desc TEXT]");
		return 2;
	}
	const opts = parseAddOptions(rest, err);
	if (!opts) return 2;

	const host: SshHost = { name, host: hostname, ...opts };
	try {
		store.add(host);
	} catch (e) {
		err((e as Error).message);
		return 1;
	}
	out(`✓ added ssh host "${name}" → ${formatTarget(host)}`);
	out(`  config: ${store.filePath}`);
	out("");
	out("Try it: codebase ssh test " + name);
	return 0;
}

function parseAddOptions(
	rest: readonly string[],
	err: (m: string) => void,
): Partial<Pick<SshHost, "user" | "port" | "identityFile" | "description">> | null {
	const out: Partial<SshHost> = {};
	for (let i = 0; i < rest.length; i++) {
		const flag = rest[i];
		const value = rest[i + 1];
		switch (flag) {
			case "--user":
			case "-u":
				if (!value) {
					err(`${flag} requires a value`);
					return null;
				}
				out.user = value;
				i++;
				break;
			case "--port":
			case "-p":
				if (!value) {
					err(`${flag} requires a value`);
					return null;
				}
				out.port = Number(value);
				i++;
				break;
			case "--key":
			case "-i":
				if (!value) {
					err(`${flag} requires a value`);
					return null;
				}
				out.identityFile = value;
				i++;
				break;
			case "--desc":
			case "--description":
				if (!value) {
					err(`${flag} requires a value`);
					return null;
				}
				out.description = value;
				i++;
				break;
			default:
				err(`unknown flag: ${flag}`);
				return null;
		}
	}
	return out;
}

function listHosts(out: (m: string) => void): number {
	const config = loadSshConfig();
	if (config.hosts.length === 0) {
		out("No SSH hosts enrolled. Add one with:");
		out("  codebase ssh add <name> <hostname>");
		return 0;
	}
	out(`${config.hosts.length} enrolled host${config.hosts.length === 1 ? "" : "s"}:`);
	for (const h of config.hosts) {
		const desc = h.description ? `  — ${h.description}` : "";
		out(`  ${h.name.padEnd(20)} ${formatTarget(h)}${desc}`);
	}
	return 0;
}

function removeHost(
	args: readonly string[],
	store: SshStore,
	out: (m: string) => void,
	err: (m: string) => void,
): number {
	const name = args[0];
	if (!name) {
		err("usage: codebase ssh rm <name>");
		return 2;
	}
	const removed = store.remove(name);
	if (!removed) {
		err(`no enrolled host named "${name}"`);
		return 1;
	}
	out(`✓ removed ssh host "${name}"`);
	return 0;
}

function testHost(args: readonly string[], out: (m: string) => void, err: (m: string) => void): number {
	const name = args[0];
	if (!name) {
		err("usage: codebase ssh test <name>");
		return 2;
	}
	const config = loadSshConfig();
	const host = config.get(name);
	if (!host) {
		err(`no enrolled host named "${name}". Try \`codebase ssh list\`.`);
		return 1;
	}
	const target = host.user ? `${host.user}@${host.host}` : host.host;
	const args2 = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=accept-new"];
	if (host.port !== undefined) args2.push("-p", String(host.port));
	if (host.identityFile) args2.push("-i", expandTilde(host.identityFile), "-o", "IdentitiesOnly=yes");
	args2.push(target, "--", "echo codebase-ssh-ok && uname -a");
	out(`→ ssh ${target} echo codebase-ssh-ok …`);
	const result = spawnSync("ssh", args2, { stdio: "inherit" });
	if (result.error) {
		err(`spawn failed: ${result.error.message}`);
		return 1;
	}
	if (result.status === 0) {
		out("");
		out("✓ connection OK");
		return 0;
	}
	err(`✗ connection failed (exit ${result.status ?? "?"})`);
	err("  Check: key on remote (~/.ssh/authorized_keys), hostname / port / user, firewall.");
	return 1;
}

interface KeygenOptions {
	rsa: boolean;
	passphrase: boolean;
}

function keygen(args: readonly string[], out: (m: string) => void, err: (m: string) => void): number {
	const name = args[0];
	if (!name || name.startsWith("-")) {
		err("usage: codebase ssh keygen <name> [--rsa] [--no-passphrase]");
		return 2;
	}
	const opts: KeygenOptions = { rsa: false, passphrase: true };
	for (const flag of args.slice(1)) {
		if (flag === "--rsa") opts.rsa = true;
		else if (flag === "--no-passphrase") opts.passphrase = false;
		else {
			err(`unknown flag: ${flag}`);
			return 2;
		}
	}

	const dir = join(homedir(), ".codebase", "ssh");
	const keyPath = join(dir, name);
	const pubPath = `${keyPath}.pub`;
	if (existsSync(keyPath)) {
		err(`key already exists at ${keyPath}. Remove it first or use a different name.`);
		return 1;
	}
	mkdirSync(dir, { recursive: true });
	try {
		chmodSync(dir, 0o700);
	} catch {
		// Windows / non-POSIX — best-effort
	}

	// Default: Ed25519 (faster, smaller key, modern crypto). --rsa
	// requests RSA-4096 for compliance / legacy infra interop.
	const keygenArgs = opts.rsa
		? ["-t", "rsa", "-b", "4096", "-f", keyPath, "-C", `codebase-cli ${name}`]
		: ["-t", "ed25519", "-f", keyPath, "-C", `codebase-cli ${name}`];
	// Empty passphrase is the headless-friendly default; --no-passphrase
	// makes it explicit, but actually we DEFAULT to no-passphrase because
	// an interactive prompt for every SSH call is unworkable for the
	// agent use case. The user can re-add a passphrase later with
	// `ssh-keygen -p -f <key>` if they want a key-encrypted-at-rest
	// setup with ssh-agent. Document this in the output.
	keygenArgs.push("-N", "");
	keygenArgs.push("-q");

	const result = spawnSync("ssh-keygen", keygenArgs, { stdio: "inherit" });
	if (result.error) {
		err(`ssh-keygen failed: ${result.error.message}. Is ssh-keygen on PATH?`);
		return 1;
	}
	if (result.status !== 0) {
		err(`ssh-keygen exited with status ${result.status ?? "?"}`);
		return 1;
	}
	try {
		chmodSync(keyPath, 0o600);
		chmodSync(pubPath, 0o644);
	} catch {
		// Best-effort on non-POSIX
	}

	const pubKey = readFileSync(pubPath, "utf8").trim();
	out(`✓ generated ${opts.rsa ? "RSA-4096" : "Ed25519"} keypair`);
	out("");
	out(`  private:  ${keyPath}  (mode 0600, no passphrase)`);
	out(`  public:   ${pubPath}`);
	out("");
	out("Public key (paste into the remote's ~/.ssh/authorized_keys):");
	out("");
	out(`  ${pubKey}`);
	out("");
	out("One-liner to install it on a remote you can already reach:");
	out("");
	out(
		`  cat ${pubPath} | ssh <user@remote> 'mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys'`,
	);
	out("");
	out("Then register the host with codebase:");
	out("");
	out(`  codebase ssh add <name> <hostname> --user <user> --key ${keyPath}`);
	if (opts.passphrase) {
		out("");
		out("(Note: we generated this key without a passphrase so the agent can use it");
		out(" non-interactively. To add a passphrase later: `ssh-keygen -p -f " + keyPath + "`)");
	}
	return 0;
}

function formatTarget(host: SshHost): string {
	const user = host.user ? `${host.user}@` : "";
	const port = host.port ? `:${host.port}` : "";
	const key = host.identityFile ? ` (key: ${host.identityFile})` : "";
	return `${user}${host.host}${port}${key}`;
}

function expandTilde(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return `${homedir()}/${p.slice(2)}`;
	return p;
}
