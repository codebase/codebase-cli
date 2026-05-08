export type PlanModeListener = (active: boolean) => void;

/**
 * Per-agent-instance flag telling the permission gate to block destructive
 * tools while the agent is producing a plan. Mode-driven by the model via
 * enter_plan_mode / exit_plan_mode tool calls, or by the App's plan flow
 * when the user approved a plan via the glue layer's Q&A.
 */
export class PlanModeStore {
	private active = false;
	private readonly listeners = new Set<PlanModeListener>();

	enter(): void {
		if (this.active) return;
		this.active = true;
		this.notify();
	}

	exit(): void {
		if (!this.active) return;
		this.active = false;
		this.notify();
	}

	isActive(): boolean {
		return this.active;
	}

	subscribe(listener: PlanModeListener): () => void {
		this.listeners.add(listener);
		listener(this.active);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private notify(): void {
		for (const listener of this.listeners) listener(this.active);
	}
}
