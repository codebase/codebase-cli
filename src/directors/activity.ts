import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Reversibility } from "../permissions/reversibility.js";

/**
 * Per-director, per-project activity log — the evidence behind graduation.
 * Append-only JSONL at `~/.codebase/projects/<cwd-hash>/directors/<slug>.jsonl`.
 * Trust is earned on a specific codebase, so the track record is scoped to
 * the project (the persona itself is global; see DirectorStore).
 *
 * What each kind means:
 *   auto-approved — reversible op the director ran on its own (no human).
 *   escalated     — irreversible/uncertain op surfaced to the human.
 *   approved      — the human said yes to an escalated/shadowed proposal.
 *   denied        — the human said no.
 *   executed      — the op actually ran (after approval or auto).
 *   error         — the op failed.
 * Only approved/denied carry a human judgement, so those drive the stats.
 */
export type ActivityKind = "auto-approved" | "escalated" | "approved" | "denied" | "executed" | "error";

export interface ActivityEvent {
	ts: number;
	kind: ActivityKind;
	tool: string;
	summary: string;
	rev: Reversibility;
	risk: "low" | "medium" | "high";
	/** Command family (shell prefix) or tool name — the unit trust is earned in. */
	family: string;
}

export interface DirectorStats {
	total: number;
	autoApproved: number;
	escalated: number;
	approved: number;
	denied: number;
	/** Denials on irreversible ops — a hard graduation blocker. */
	deniedIrreversible: number;
	/** Per command-family agreement: how often the human approved what the director proposed. */
	byFamily: Record<string, { proposed: number; approved: number }>;
}

export class ActivityLog {
	private readonly path: string;

	constructor(opts: { cwd: string; slug: string; dataRoot?: string }) {
		const root = opts.dataRoot ?? join(homedir(), ".codebase");
		const hash = createHash("sha256").update(opts.cwd).digest("hex").slice(0, 8);
		this.path = join(root, "projects", hash, "directors", `${opts.slug}.jsonl`);
	}

	/** Append one event. `ts` defaults to now; pass it for deterministic tests. */
	append(event: Omit<ActivityEvent, "ts"> & { ts?: number }): ActivityEvent {
		const full: ActivityEvent = { ts: event.ts ?? Date.now(), ...event };
		mkdirSync(dirname(this.path), { recursive: true });
		appendFileSync(this.path, `${JSON.stringify(full)}\n`, "utf8");
		return full;
	}

	read(): ActivityEvent[] {
		if (!existsSync(this.path)) return [];
		const out: ActivityEvent[] = [];
		for (const line of readFileSync(this.path, "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				out.push(JSON.parse(line) as ActivityEvent);
			} catch {
				// Tolerate a torn final line from a crash mid-append.
			}
		}
		return out;
	}

	stats(): DirectorStats {
		const s: DirectorStats = {
			total: 0,
			autoApproved: 0,
			escalated: 0,
			approved: 0,
			denied: 0,
			deniedIrreversible: 0,
			byFamily: {},
		};
		for (const e of this.read()) {
			s.total++;
			if (e.kind === "auto-approved") s.autoApproved++;
			else if (e.kind === "escalated") s.escalated++;
			else if (e.kind === "approved" || e.kind === "denied") {
				// Only human-judged proposals count toward earned agreement.
				s.byFamily[e.family] ??= { proposed: 0, approved: 0 };
				const fam = s.byFamily[e.family];
				fam.proposed++;
				if (e.kind === "approved") {
					s.approved++;
					fam.approved++;
				} else {
					s.denied++;
					if (e.rev === "irreversible") s.deniedIrreversible++;
				}
			}
		}
		return s;
	}
}

/** Agreement rate (0–1) for a family, or null if no judged proposals yet. */
export function agreementRate(fam: { proposed: number; approved: number }): number | null {
	return fam.proposed === 0 ? null : fam.approved / fam.proposed;
}
