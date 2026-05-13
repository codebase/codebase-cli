import { Container, SelectList, Text } from "@mariozechner/pi-tui";
import type { PermissionRequest, ResponseChoice } from "../permissions/store.js";
import { ansi, selectListTheme } from "./theme.js";

/**
 * Inline overlay shown when a tool call needs user approval. Renders
 * the request summary, risk badge, and an arrow-navigable choice list.
 * Hands control back via the onRespond callback the caller wires to
 * `bundle.permissions.respond(id, choice)`.
 */
export class PermissionOverlay extends Container {
	private readonly list: SelectList;

	constructor(request: PermissionRequest, onRespond: (choice: ResponseChoice) => void) {
		super();

		const risk = request.risk;
		const riskColor = risk === "high" ? ansi.red : ansi.yellow;
		const riskLabel = risk === "high" ? "HIGH RISK" : risk === "medium" ? "REVIEW" : "LOW RISK";

		this.addChild(new Text(`${riskColor(ansi.bold(riskLabel))} · permission needed`, 1, 0));
		this.addChild(new Text(`${ansi.bold(request.tool)}  ${request.summary}`, 1, 0));
		if (request.detail) {
			this.addChild(new Text(ansi.dim(truncate(request.detail, 600)), 1, 0));
		}

		this.list = new SelectList(
			[
				{ value: "allow-once", label: "Allow once", description: "this one time" },
				{ value: "trust-tool", label: "Trust tool", description: "for the rest of this session" },
				{ value: "trust-all", label: "Trust all", description: "any tool, this session" },
				{ value: "deny", label: "Deny", description: "block this call" },
			],
			4,
			selectListTheme,
		);
		this.list.onSelect = (item) => onRespond(item.value as ResponseChoice);
		this.list.onCancel = () => onRespond("deny");
		this.addChild(this.list);
		this.addChild(new Text(ansi.dim("↑↓ Enter to confirm · Esc denies"), 1, 0));
	}

	/** Focus target for the TUI — the SelectList consumes arrow keys + Enter. */
	getFocusTarget(): SelectList {
		return this.list;
	}
}

function truncate(s: string, n: number): string {
	if (s.length <= n) return s;
	return `${s.slice(0, n - 1)}…`;
}
