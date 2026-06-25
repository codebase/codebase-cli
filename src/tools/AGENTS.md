# DOX: Tools

## Purpose

- Own built-in agent tools: file reads/writes/edits, shell, git, grep/glob/list, web fetch/search, MCP resources, tasks, dispatch-agent, notebook edits, ask-user, monitors, SSH exec, and checkpoint wrappers.

## Local Contracts

- All file tools must resolve paths safely inside the current working directory unless a tool explicitly supports broader scope.
- Write/edit tools must preserve read-before-edit and checkpoint expectations.
- Shell/git/SSH tools must classify effects and go through permission policy.
- Search/list tools must ignore standard VCS/build/dependency directories by default.
- Tool outputs should be capped and structured enough for UI/headless consumers.

## Work Guidance

- Keep validation close to the tool implementation.
- Add tests for path traversal, symlink, binary/large file, timeout, and denied-permission paths when touching high-risk tools.

## Verification

- Run targeted `src/tools/*.test.ts`.
- Run `npm run check` after changing shared tool types, registry, permission effects, or checkpoint wrappers.

## Child DOX Index

- No child DOX files yet.
