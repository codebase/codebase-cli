/**
 * Reasoning-effort levels, mapped to pi-agent-core's ThinkingLevel. The
 * agent reads a persisted level at start and `/effort` mutates
 * `agent.state.thinkingLevel` live for the next turn. Models that don't
 * support reasoning ignore it, so a level is always safe to set.
 */

export type Effort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export const EFFORT_LEVELS: readonly Effort[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

/** Validate/normalize a persisted or user-typed level; undefined when unset/invalid. */
export function resolveEffort(value: string | undefined): Effort | undefined {
	if (!value) return undefined;
	const v = value.trim().toLowerCase();
	return (EFFORT_LEVELS as readonly string[]).includes(v) ? (v as Effort) : undefined;
}
