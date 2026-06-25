# DOX: SSH

## Purpose

- Own SSH host config, CLI subcommands, host validation, key generation guidance, and SSH command execution support.

## Local Contracts

- Host names, hostnames, ports, users, and identity paths must be validated strictly.
- Do not allow `user@host:port` shorthand where separate fields are required.
- SSH execution must use the same safety/permission posture as local shell execution where applicable.

## Work Guidance

- Keep generated key messaging clear about passphrase tradeoffs.
- Warn and skip invalid host entries instead of crashing config load.

## Verification

- Run `npx vitest --run src/ssh`.
- Run related shell/tool tests when SSH execution behavior changes.

## Child DOX Index

- No child DOX files yet.
