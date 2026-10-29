import { Container, SelectList, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { frame, frameInnerWidth } from "./overlay-frame.js";
import { ansi, selectListTheme } from "./theme.js";

export interface ModelOption {
	id: string;
	name: string;
	provider: string;
}

/**
 * Overlay for /model — given a list of available models, lets the user
 * pick with arrow keys + Enter. The active model is annotated in the
 * description so the picker reads cleanly even without a separate cursor
 * tracker.
 *
 * Picking "Codebase Auto" sends back a null spec so the App clears the
 * persisted preference. Esc cancels the picker without touching state.
 */
const ACTIVE = "\x1b[38;2;78;186;94m";
const CYAN = "\x1b[36m";
const FG_OFF = "\x1b[39m";

export class ModelPickerOverlay extends Container {
	private readonly list: SelectList;

	constructor(
		currentId: string,
		currentProvider: string,
		models: ModelOption[],
		onSelect: (spec: { provider?: string; modelId: string } | null) => void,
		onCancel: () => void,
		includeReset = true,
	) {
		super();

		this.addChild(new Text(ansi.bold("Switch model"), 0, 0));
		this.addChild(new Text(ansi.dim("↑↓ choose · Enter select · Esc cancel"), 0, 0));

		// First synthetic entry: reset to Codebase Auto — a proxy-only concept,
		// omitted for BYOK / local sessions where there's no proxy default.
		let activeValue: string | undefined;
		const items = [
			...(includeReset
				? [{ value: "__reset__", label: "Codebase Auto", description: "let the proxy pick (default for OAuth)" }]
				: []),
			...models.map((m) => {
				const active = m.id === currentId && m.provider === currentProvider;
				const value = `${m.provider}::${m.id}`;
				if (active) activeValue = value;
				return { value, label: active ? `${m.name} ✓` : m.name, description: `${m.provider}/${m.id}` };
			}),
		];

		this.list = new SelectList(items, Math.min(12, Math.max(4, items.length)), selectListTheme, {
			// The active model's name is green; hand back the highlighted row's cyan afterwards.
			truncatePrimary: ({ text, maxWidth, item, isSelected }) => {
				const shown = truncateToWidth(text, maxWidth, "");
				return item.value === activeValue ? `${ACTIVE}${shown}${isSelected ? CYAN : FG_OFF}` : shown;
			},
		});
		this.list.onSelect = (item) => {
			if (item.value === "__reset__") {
				onSelect(null);
				return;
			}
			const [provider, modelId] = String(item.value).split("::");
			onSelect({ provider, modelId });
		};
		this.list.onCancel = onCancel;
		this.addChild(this.list);
	}

	getFocusTarget(): SelectList {
		return this.list;
	}

	override render(width: number): string[] {
		return frame(super.render(frameInnerWidth(width)), width);
	}
}
