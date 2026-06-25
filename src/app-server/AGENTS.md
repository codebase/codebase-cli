# DOX: App Server

## Purpose

- Own the local app-server protocol and server used to communicate with companion app/UI surfaces.

## Local Contracts

- Keep protocol messages versioned or backwards-compatible when possible.
- Validate inbound messages before dispatching work.
- Do not expose localhost server capabilities beyond intended clients without auth/origin checks.

## Work Guidance

- Keep protocol definitions central in `protocol.ts`.
- Test request/response and lifecycle behavior with server tests.

## Verification

- Run `npx vitest --run src/app-server`.

## Child DOX Index

- No child DOX files yet.
