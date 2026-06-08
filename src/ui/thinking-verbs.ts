/**
 * Engineering-themed verbs cycled in the status bar while the agent is
 * busy. The aesthetic is "your computer is working on this," not "your
 * assistant is gently pondering" — verbs map to actual machine work
 * (compiling, indexing, tracing) rather than human-cognition metaphors.
 * ASCII-clean so they line up in any terminal font.
 *
 * Shared between `src/ui/Status.tsx` (ink path) and `src/ui-pi/app.ts`
 * (pi-tui path) so the two render paths read the same and the
 * vocabulary stays consistent.
 */
export const THINKING_VERBS: readonly string[] = [
	"Thinking",
	"Compiling",
	"Indexing",
	"Resolving",
	"Parsing",
	"Tracing",
	"Diffing",
	"Profiling",
	"Computing",
	"Linking",
	"Optimizing",
	"Stashing",
	"Bisecting",
	"Memoizing",
	"Tokenizing",
	"Hoisting",
	"Reticulating",
	"Refactoring",
	"Bundling",
	"Pruning",
	"Spawning",
	"Crunching",
	"Marshaling",
	"Currying",
	"Folding",
	"Reducing",
	"Lexing",
	"Yak-shaving",
	"Caching",
	"Threading",
	"Vendoring",
	"Inlining",
	"Hashing",
	"Allocating",
	"Branching",
];

/**
 * Pick the next verb at random, excluding the current one so the same
 * word doesn't reappear at predictable beats. Used by both render paths
 * on a 3-second cadence while the agent is thinking.
 */
export function pickNextVerb(current: string): string {
	let next = current;
	while (next === current) {
		next = THINKING_VERBS[Math.floor(Math.random() * THINKING_VERBS.length)];
	}
	return next;
}
