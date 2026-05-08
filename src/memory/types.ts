export type MemoryType = "user" | "feedback" | "project" | "reference";

export const MEMORY_TYPES: readonly MemoryType[] = ["user", "feedback", "project", "reference"];

export interface MemoryFrontmatter {
	name: string;
	description: string;
	type: MemoryType;
}

export interface MemoryRecord extends MemoryFrontmatter {
	filename: string;
	body: string;
	updatedAt: number;
}

export function parseMemoryType(raw: string): MemoryType | null {
	const normalized = raw.trim().toLowerCase();
	for (const t of MEMORY_TYPES) {
		if (t === normalized) return t;
	}
	return null;
}
