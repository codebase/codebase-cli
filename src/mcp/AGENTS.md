# DOX: MCP

## Purpose

- Own MCP configuration, stdio/HTTP clients, OAuth metadata/token flows, protocol types, server manager, and conversion of MCP tools/resources into agent tools.

## Local Contracts

- Remote MCP connections must validate URLs, auth metadata, and token handling.
- Stdio MCP commands must be explicit and must not silently execute arbitrary shell fragments from untrusted config.
- Tool adaptation must preserve schemas and avoid losing permission/effect context.

## Work Guidance

- Keep protocol compatibility code isolated from UI command handling.
- Test malformed configs, missing command/url, invalid JSON, auth errors, and server lifecycle cleanup.

## Verification

- Run `npx vitest --run src/mcp`.
- Run `npm run typecheck` after protocol/schema changes.

## Child DOX Index

- No child DOX files yet.
