# DOX: Benchmarks

## Purpose

- Own benchmark scenarios, runner scripts, aggregate reports, and benchmark result artifacts.

## Local Contracts

- Benchmark scenarios must be reproducible and should document model/provider assumptions.
- Do not treat benchmark results as marketing claims unless methodology and dates are included.
- Keep generated result files separate from source scenarios.

## Work Guidance

- Prefer small scenario fixtures with explicit expected behavior.
- Record environment details when adding new result artifacts.

## Verification

- Run `npm run bench` or targeted benchmark scripts when changing runner/scenario behavior.
- Run `npm run bench:report` after changing aggregation.

## Child DOX Index

- No child DOX files yet.
