# Testing — Legion v2

## Overview

Legion v2 has two test layers:

- **Unit / integration tests** — [Vitest](https://vitest.dev/), covers `core`, `runtime`, `types`, and `web`
- **End-to-end tests** — [Playwright](https://playwright.dev/), covers the full running stack via `packages/e2e`

This document covers the unit/integration layer, including coverage measurement.

---

## Running Tests

### Unit tests (all packages except web)

```sh
npm test                  # run once
npm run test:watch        # watch mode
```

Vitest picks up files matching:

```
packages/**/src/**/*.test.ts
packages/**/src/**/*.integration.test.ts
```

`packages/web` is excluded from the root config and must be run separately (see below).

### Web package tests

```sh
npm run test --workspace=packages/web
```

Uses `happy-dom` as the DOM environment and `@vue/test-utils` for Vue component testing.

### End-to-end tests

```sh
npm run test:e2e
```

See [`docs/superpowers/specs/2026-06-16-e2e-testing-design.md`](superpowers/specs/2026-06-16-e2e-testing-design.md) for the e2e design.

---

## Coverage

Coverage is provided by [`@vitest/coverage-v8`](https://vitest.dev/guide/coverage) (V8 native — no instrumentation required).

Reports are written to:

| Scope                        | Output directory           |
| ---------------------------- | -------------------------- |
| `core` / `runtime` / `types` | `./coverage/`              |
| `web`                        | `./packages/web/coverage/` |

Three report formats are generated: `text` (terminal table), `html` (browsable), and `lcov` (CI tools).

### Run coverage

```sh
# core, runtime, types only
npm run test:coverage

# web package only
npm run test:coverage --workspace=packages/web

# with integration tests enabled (see below)
npm run test:coverage:integration
```

---

## Integration Tests

Integration tests live alongside unit tests but use the `.integration.test.ts` suffix. They are **skipped by default** and enabled via environment variables.

### Environment variables

| Variable                                | Tests enabled                                                              | Notes                                                                                                                                                                                           |
| --------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LEGION_INTEGRATION=1`                  | `LegionProcess.integration.test.ts`, `WebConnector.ws.integration.test.ts` | Starts a real Fastify server on port 3000 — ensure the port is free                                                                                                                             |
| `LEGION_MCP_INTEGRATION=1`              | `MCPToolSource.integration.test.ts`                                        | Spawns real MCP subprocess                                                                                                                                                                      |
| `LEGION_OPENAI_INTEGRATION=1`           | `agent-runtime.integration.test.ts`                                        | Requires a live OpenAI-compatible API key; uses `gpt-4o-mini` by default (override with `OPENAI_MODEL`)                                                                                         |
| `LEGION_OPENAI_RESPONSES_INTEGRATION=1` | `OpenAIResponsesProvider.integration.test.ts`                              | Requires a live OpenAI API key; exercises the Responses wire (`/responses`); model `gpt-4o-mini` by default (override with `OPENAI_RESPONSES_MODEL`, base URL with `OPENAI_RESPONSES_BASE_URL`) |

### Running with integration tests

```sh
# MCP integration only (no port requirement, no API key)
LEGION_MCP_INTEGRATION=1 npm run test:coverage

# Full local integration (port 3000 must be free)
npm run test:coverage:integration

# All integration tests including OpenAI (requires API key)
LEGION_INTEGRATION=1 LEGION_MCP_INTEGRATION=1 LEGION_OPENAI_INTEGRATION=1 npm run test:coverage
```

`npm run test:coverage:integration` is shorthand for `LEGION_INTEGRATION=1 LEGION_MCP_INTEGRATION=1 vitest run --coverage`. It does **not** include `LEGION_OPENAI_INTEGRATION` since that requires external credentials.

---

## Coverage Notes

- **`@legion-collective/types`** shows 0% statement coverage — expected, as it contains only TypeScript type/interface definitions with no executable statements.
- **Abstract base classes** (`Runtime.ts`, `Storage.ts`, `Provider.ts`, etc.) show 0% because they export interfaces or abstract classes with no instantiable logic; their concrete implementations are covered.
- **`LegionProcess.ts`** shows very low coverage without `LEGION_INTEGRATION=1` because its integration tests are skipped. With the env var set and port 3000 free, coverage rises substantially.
- **`WebConnector.ts`** coverage is partial because the WebSocket integration tests (`WebConnector.ws.integration.test.ts`) require `LEGION_INTEGRATION=1`.
