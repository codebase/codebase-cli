# DOX: Permissions

## Purpose

- Own command-prefix permission policy, persistent permission store, and allow/block decisions for effectful operations.

## Local Contracts

- Deny/allow matching must be predictable and explainable to users.
- Permission state must not accidentally broaden scope across unrelated projects or commands.
- Effectful tools should consult permission policy before execution.

## Work Guidance

- Keep pattern matching and precedence rules heavily tested.
- Prefer explicit normalized command prefixes over fuzzy matching.

## Verification

- Run `npx vitest --run src/permissions`.
- Run related tool permission tests when changing interfaces.

## Child DOX Index

- No child DOX files yet.
