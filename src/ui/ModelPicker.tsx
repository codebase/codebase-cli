import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";

export interface ModelOption {
	id: string;
	name: string;
	provider: string;
}

interface ModelPickerProps {
	/** Currently active model — rendered with an "* active" marker. */
	currentId: string;
	currentProvider: string;
	/** Resolves the list once the overlay mounts. Returns models or throws. */
	loadModels: () => Promise<ModelOption[]>;
	/** Called when the user picks. `null` = reset to default (Codebase Auto). */
	onSelect: (spec: { provider?: string; modelId: string } | null) => void;
	onCancel: () => void;
}

/**
 * Inline overlay for switching the active model. Mounts when `/model` is
 * called with no args, fetches available models from the proxy, and lets
 * the user pick with arrow keys + Enter. Esc cancels.
 *
 * Models are grouped by provider for readability — the cursor walks the
 * flat list, but each provider group prints its own header row.
 */
export function ModelPicker({ currentId, currentProvider, loadModels, onSelect, onCancel }: ModelPickerProps) {
	const [models, setModels] = useState<ModelOption[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [cursor, setCursor] = useState(0);

	useEffect(() => {
		let cancelled = false;
		loadModels()
			.then((list) => {
				if (cancelled) return;
				setModels(list);
				setLoading(false);
				// Land the cursor on the currently active model if it's in the
				// list — otherwise the user has to hunt for "where am I."
				const activeIdx = list.findIndex((m) => m.id === currentId && m.provider === currentProvider);
				if (activeIdx >= 0) setCursor(activeIdx);
			})
			.catch((err) => {
				if (cancelled) return;
				setError(err instanceof Error ? err.message : String(err));
				setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [loadModels, currentId, currentProvider]);

	useInput((input, key) => {
		if (key.escape) {
			onCancel();
			return;
		}
		if (loading || error) return;
		if (key.return) {
			const picked = models[cursor];
			if (picked) onSelect({ provider: picked.provider, modelId: picked.id });
			return;
		}
		if (key.upArrow || (key.shift && key.tab)) {
			setCursor((c) => (c - 1 + models.length) % models.length);
			return;
		}
		if (key.downArrow || key.tab) {
			setCursor((c) => (c + 1) % models.length);
			return;
		}
		// `r` resets to the default (Codebase Auto) for proxy users.
		if (input.toLowerCase() === "r") {
			onSelect(null);
		}
	});

	if (loading) {
		return (
			<Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
				<Text bold color="cyan">
					Select model
				</Text>
				<Box marginTop={1}>
					<Text dimColor>Loading models from proxy…</Text>
				</Box>
			</Box>
		);
	}

	if (error) {
		return (
			<Box flexDirection="column" borderStyle="round" borderColor="red" paddingX={1}>
				<Text bold color="red">
					Couldn't load models
				</Text>
				<Box marginTop={1}>
					<Text>{error}</Text>
				</Box>
				<Box marginTop={1}>
					<Text dimColor>Esc to dismiss</Text>
				</Box>
			</Box>
		);
	}

	// Compute provider-group boundaries for the rendered list. Cursor still
	// walks the flat model array; headers are rendered between groups but
	// not selectable.
	const grouped = groupByProvider(models);

	return (
		<Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginY={0}>
			<Box>
				<Text bold color="cyan">
					Select model
				</Text>
				<Text dimColor> · ↑↓ navigate · Enter selects · r resets to default · Esc cancels</Text>
			</Box>
			<Box marginTop={1} flexDirection="column">
				{grouped.map((group) => (
					<Box key={`grp-${group.provider}`} flexDirection="column">
						<Text dimColor>{group.provider}</Text>
						{group.items.map((entry) => {
							const isCursor = entry.flatIndex === cursor;
							const isActive = entry.model.id === currentId && entry.model.provider === currentProvider;
							const marker = isCursor ? "▸" : isActive ? "*" : " ";
							const label =
								entry.model.name === entry.model.id
									? entry.model.id
									: `${entry.model.id}  · ${entry.model.name}`;
							return (
								<Text
									key={`m-${entry.model.provider}-${entry.model.id}`}
									color={isCursor ? "cyan" : undefined}
									bold={isCursor}
									dimColor={!isCursor && !isActive}
								>
									{`  ${marker} ${label}`}
								</Text>
							);
						})}
					</Box>
				))}
			</Box>
		</Box>
	);
}

function groupByProvider(
	models: ModelOption[],
): Array<{ provider: string; items: Array<{ model: ModelOption; flatIndex: number }> }> {
	const groups = new Map<string, Array<{ model: ModelOption; flatIndex: number }>>();
	models.forEach((m, flatIndex) => {
		const arr = groups.get(m.provider) ?? [];
		arr.push({ model: m, flatIndex });
		groups.set(m.provider, arr);
	});
	return [...groups.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([provider, items]) => ({ provider, items }));
}
