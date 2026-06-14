import { Container, SelectList, Text } from "@earendil-works/pi-tui";
import type { TournamentOutcome } from "../agent/tournament.js";
import { ansi, selectListTheme } from "./theme.js";

/**
 * Results overlay for /tournament. Lists each finished attempt in the
 * judge's ranking — files changed + one-line rationale — with the judge's
 * pick preselected. Enter merges the highlighted attempt (the user can
 * override the judge); Esc discards them all.
 */
export class TournamentOverlay extends Container {
	private readonly list: SelectList;

	constructor(outcome: TournamentOutcome, onPick: (branchId: string) => void, onCancel: () => void) {
		super();

		this.addChild(new Text(ansi.bold("Tournament results"), 1, 0));
		this.addChild(new Text(ansi.dim("↑↓ choose · Enter merge · Esc discard all"), 1, 0));

		// Order by the judge's ranking; unranked/failed attempts fall to the end.
		const order = new Map(outcome.verdict.ranking.map((r, i) => [r.id, i]));
		const rationale = new Map(outcome.verdict.ranking.map((r) => [r.id, r.rationale]));
		const sorted = [...outcome.branches].sort((a, b) => (order.get(a.id) ?? 999) - (order.get(b.id) ?? 999));

		const items = sorted.map((b) => {
			const tag = b.id === outcome.verdict.winnerId ? " · judge's pick" : "";
			const status = b.error
				? `failed: ${b.error}`
				: `${b.filesChanged.length} file${b.filesChanged.length === 1 ? "" : "s"}${b.model ? ` · ${b.model}` : ""}`;
			const why = rationale.get(b.id);
			return {
				value: b.id,
				label: `Attempt ${b.id} — ${status}${tag}`,
				description: why || b.summary.slice(0, 80) || "(no notes)",
			};
		});

		this.list = new SelectList(items, Math.min(10, Math.max(3, items.length)), selectListTheme);
		// Preselect the judge's pick so Enter does the expected thing.
		const winnerIdx = sorted.findIndex((b) => b.id === outcome.verdict.winnerId);
		if (winnerIdx > 0) this.list.setSelectedIndex(winnerIdx);
		this.list.onSelect = (item) => onPick(String(item.value));
		this.list.onCancel = onCancel;
		this.addChild(this.list);
	}

	getFocusTarget(): SelectList {
		return this.list;
	}
}
