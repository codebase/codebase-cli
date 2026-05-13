import { Container, SelectList, Text } from "@mariozechner/pi-tui";
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
export class ModelPickerOverlay extends Container {
	private readonly list: SelectList;

	constructor(
		currentId: string,
		currentProvider: string,
		models: ModelOption[],
		onSelect: (spec: { provider?: string; modelId: string } | null) => void,
		onCancel: () => void,
	) {
		super();

		this.addChild(new Text(ansi.bold("Switch model"), 1, 0));
		this.addChild(new Text(ansi.dim("↑↓ choose · Enter select · Esc cancel"), 1, 0));

		// First synthetic entry: reset to Codebase Auto. Always first so it
		// stays in the same slot regardless of provider order.
		const items = [
			{
				value: "__reset__",
				label: "Codebase Auto",
				description: "let the proxy pick (default for OAuth)",
			},
			...models.map((m) => {
				const active = m.id === currentId && m.provider === currentProvider;
				return {
					value: `${m.provider}::${m.id}`,
					label: m.name,
					description: `${m.provider}/${m.id}${active ? " · active" : ""}`,
				};
			}),
		];

		this.list = new SelectList(items, Math.min(12, Math.max(4, items.length)), selectListTheme);
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
}
