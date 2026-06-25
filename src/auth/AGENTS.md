# DOX: Auth

## Purpose

- Own cloud authentication: browser/device OAuth flows, callback server, PKCE, token exchange/refresh, credential file storage, CLI auth commands, and credential validation.

## Local Contracts

- Credential files must be permission-hardened and never logged in full.
- Refresh/token exchange code must handle expiry, invalid JSON, version mismatch, and concurrent refresh safely.
- OAuth state, PKCE verifier, and redirect handling must defend against replay/mismatch.

## Work Guidance

- Keep network calls injectable for tests.
- Prefer clear recovery messages that tell users how to re-authenticate.

## Verification

- Run `npx vitest --run src/auth`.
- Run `npm run check` for credential or token-manager changes.

## Child DOX Index

- No child DOX files yet.
