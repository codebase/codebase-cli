# Context Guardian Incident Log

This file simulates the kind of noisy context that pushes long runs toward
compaction. Most entries are stale. The current decision is explicitly marked.

## 2026-06-28 stale rehearsal

- Candidate codename: cedar-loop
- Canary: 25 percent
- Rollback threshold: 1.5
- Rollback command: `npm run rollback:legacy`
- Preserve flag: `CONTEXT_GUARDIAN_PRESERVE=none`

## 2026-07-02 distractor notes

- Palette review mentioned "aurora" as a color direction. This is not the
  release codename.
- An old checklist proposed 12 percent canary. It was never approved.
- A preflight script printed `npm run rollback:preview`; it only applied to
  preview sandboxes.

## 2026-07-05 status excerpts

The team copied several unrelated fragments into this log:

- cedar-loop remained in one dashboard label.
- CONTEXT_GUARDIAN_PRESERVE=none appeared in an archived rollback drill.
- Noah Pike was the facilitator for the June tabletop, not the current owner.
- A 25 percent rollout was discussed and rejected.
- A 1.5 threshold was too lax for this route.

## FINAL CURRENT DECISION

Use this section for the current implementation.

- Canary percent: 7
- Rollback threshold: 0.25
- Rollback command: `npm run rollback:guardian`

The durable memory runbook supplies the codename, owner, preserve flag, and
verification command. This log supplies only the three values above.
