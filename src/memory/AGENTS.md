# DOX: Memory

## Purpose

- Own durable memory extraction, manual quick-add, index files, injection into prompts, store format, and memory types.

## Local Contracts

- Do not store secrets, tokens, private keys, or sensitive credentials in memory.
- Memory extraction should prefer durable project/user facts over transient session chatter.
- Index truncation must preserve valid, readable content and avoid unbounded prompt growth.

## Work Guidance

- Keep extraction prompts conservative and auditable.
- Preserve backwards compatibility with existing memory files where possible.

## Verification

- Run `npx vitest --run src/memory`.
- Add tests for store format or truncation changes.

## Child DOX Index

- No child DOX files yet.
