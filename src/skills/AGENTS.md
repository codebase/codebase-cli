# DOX: Skills

## Purpose

- Own skill discovery, local/platform loaders, skill registry construction, validation, and type definitions.

## Local Contracts

- Skill ids must be validated and must not collide silently with built-in commands.
- Skill loading should skip invalid entries with clear warnings rather than crash the CLI.
- Skills must not gain filesystem/network/tool permissions outside normal agent tool policy.

## Work Guidance

- Keep local and platform loading paths consistent.
- Test invalid names, missing files, malformed metadata, and command collisions.

## Verification

- Run `npx vitest --run src/skills`.
- Run command tests when skill commands or registry behavior changes.

## Child DOX Index

- No child DOX files yet.
