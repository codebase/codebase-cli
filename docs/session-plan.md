# Session save / resume / compaction plan

> Status: draft — pre.25 lands auto-resume + `/new` + `/debug context`; the rest is sequenced below.

The TUI starts a fresh agent on every launch by default (until pre.25). Sessions ARE saved on every `agent_end` (`src/agent/agent.ts:239`) but the interactive path never sets `opts.resume`, so all that persistence does nothing for the in-CLI experience. This plan closes that gap and lays out the compaction story.

## What pre.25 ships

1. **Auto-resume by default.** `codebase` in a directory with a session ≤7 days old + same model loads the prior messages back into the agent before the user can prompt. `--new` flag opts out per-launch.
2. **`/new` slash command.** Wipes both `state.messages` (display) and `bundle.agent.state.messages` (model context). The mid-session "start over" button.
3. **`/debug` slash command.** Shows display message count vs agent internal message count side by side — diagnostic for "the model isn't remembering me" complaints.

## Today, on disk

```
~/.codebase/sessions/{sha256(cwd)[:8]}.json
{
  "formatVersion": 1,
  "workDir": "/abs/path",
  "modelId": "MiniMax-M2.7",
  "title": null,
  "messages": [...],
  "usage": {...},
  "updatedAt": 1747...
}
```

One file per cwd. Overwritten on every `agent_end`. Auto-discarded if older than 7 days or if the saved `modelId` doesn't match the currently-resolved model. Path computed from `sha256(cwd).slice(0, 8)` so multiple worktrees stay separate.

## Gaps to close (priority order)

### 1. Save on abort and graceful exit, not just agent_end
**Why:** A turn cancelled mid-flight (Ctrl-C) or a clean exit (`/exit`, Ctrl-D) leaves the most recent in-flight assistant message unsaved. Reopening the CLI loses that last message.
**How:** Hook into `bundle.agent.abort()` and the process exit path; call `sessions.save(...)` with the agent's current `_state.messages`.
**Effort:** S

### 2. Multi-session per cwd (rotation)
**Why:** Today one file per cwd; new session overwrites the old one. Users can't browse history.
**How:**
- Keep last N sessions per cwd (e.g. N=5). Rename current to `{hash}.{ts}.json` on rotation.
- `/sessions` lists them with timestamps + first-message previews.
- `/resume {id}` loads a specific archived session.
**Effort:** M

### 3. Allow resume across model changes (with a warning)
**Why:** Today `parsed.modelId !== modelId` returns null — switching from Claude to MiniMax discards your session. Compaction summaries and tool call shapes mostly survive a model swap, just not perfectly.
**How:** On model mismatch, still resume but emit a soft warning ("Resumed from a session on a different model — some context may be re-interpreted").
**Effort:** S

### 4. Session metadata for findability
**Why:** Resumed-from cards in the welcome banner only show "N hours ago, M messages." If users have several worktrees, that's not enough to distinguish.
**How:**
- Generate a short title via the glue LLM on first save (one-line summary of the first user prompt).
- Display "Resumed: 'add OAuth flow' · 47 messages · 2h ago".
- `/sessions` list uses titles too.
**Effort:** S (glue call is already wired)

### 5. Per-session log of file operations
**Why:** Compaction loses the body of tool calls. If we want to answer "did I edit `src/foo.ts` in this session?" after a compaction pass, we need a separate audit log.
**How:** Append to `~/.codebase/sessions/{hash}.fileops.jsonl` on every successful `edit_file` / `write_file` / `multi_edit`. Survives compaction.
**Effort:** M

## Compaction — what's there and what's missing

`src/compaction/engine.ts` already does the work:
- Threshold: 75% of model context window (`DEFAULT_THRESHOLD = 0.75`).
- `transformContext` hook on the agent loop calls `compact()` when the threshold is crossed.
- `glue` LLM summarizes older messages, keeps recent N verbatim.
- `compaction_start` / `compaction_end` events emitted (we don't render them yet).

What's missing:

### A. Visible "Compacting…" notification
**Why:** When the agent pauses for several seconds during a long session, users have no signal that it's compaction (not a hang).
**How:** Subscribe to `compaction_start` in the reducer → set a `status: "compacting"` state → render in the status bar. `compaction_end` clears it.
**Effort:** S

### B. CompactionDetails with file-op tracking
**Why:** Per pi-mono pattern (`.settings/compare/pi-mono.md:103-122` in polyvibe-poc). After compaction, the summary should preserve which files were read / modified across the compacted range. The model uses this to maintain coherent file references when older context is summarized away.
**How:** Extend `CompactionResult.details` with `{ readFiles: string[], modifiedFiles: string[] }` extracted from the compacted message range's tool calls. Surface via `/context` and `/debug`.
**Effort:** M

### C. Snip-then-summarize pre-step (Claude Code pattern)
**Why:** Today compaction summarizes the whole compactable range in one LLM call. If half of that range is verbose tool output that the model already extracted what it needs from, we're paying for summarization tokens twice.
**How:** Before the summarize call, "snip": drop tool_result bodies for tool calls whose result the assistant clearly used (e.g. the assistant message immediately after quoted the file content). Summarize what remains.
**Effort:** L (heuristics are tricky)

### D. User control: `/compact` already exists
**Why:** Already shipped — forces a compaction pass on demand. Good. Just needs the visible notification (item A).

## Where to look for inspiration

| Topic | Source |
|---|---|
| Compaction with file-op preservation | `.pi-mono/packages/coding-agent/src/core/compaction/compaction.ts` |
| Session JSONL format with branches | `.pi-mono/packages/coding-agent/src/core/session-manager.ts` |
| Multi-session UX | Claude Code's `claude --continue` / `claude --resume {id}` pattern (`~/claude-code-source/`) |
| Web app's conversation manager | `web/backend/agent/conversationManager.js` in polyvibe-poc |

## Sequencing recommendation

1. **pre.25 (this release):** auto-resume default, `--new`, `/new`, `/debug context`. → unblocks the "across launches" complaint.
2. **pre.26:** items 1 + 3 + A. → makes the auto-resume safer (save on abort) and visible (compacting indicator).
3. **pre.27:** items 2 + 4 (multi-session rotation + titles). → makes history navigable.
4. **pre.28+:** B / C / 5. → polish for power users / very long sessions.
