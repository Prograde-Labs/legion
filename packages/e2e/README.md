# @legion/e2e — End-to-End Tests

Playwright E2E suite for the Legion v2 web interface, HTTP API, and WebSocket layer.

## Prerequisites

- Node >= 20
- Monorepo dependencies installed: `npm install`
- Runtime and web packages built: `npm run build`
- Playwright Chromium browser installed: `npx playwright install chromium`

## Running the full suite

```bash
npm run test:e2e
```

## Running a single spec file

```bash
npm run test:e2e -- tests/auth/login.spec.ts
```

## How server lifecycle works

`global-setup.ts` runs once before all tests:
1. Creates a temp workspace dir at `/tmp/legion-e2e-<timestamp>/`
2. Starts a mock OpenAI-compatible HTTP server in-process on port **4001**
3. Spawns the Legion server via `node packages/runtime/bin/legion.js` on port **4000**
   with `LEGION_BOOTSTRAP_PASSWORD=legion-e2e-test` and `LEGION_WORKSPACE=<temp dir>`
4. Polls `GET /api/health` until ready (max 15s)
5. Writes connection info to `/tmp/legion-e2e.json`

After all tests complete, the returned teardown function kills the server, stops the mock
provider, and removes the temp workspace.

## The mock LLM provider

`mock-provider/server.ts` implements two OpenAI endpoints:

| Endpoint | Response |
|---|---|
| `GET /v1/models` | `{ data: [{ id: "mock-model" }] }` |
| `POST /v1/chat/completions` | `{ choices: [{ message: { role: "assistant", content: "mock response" } }] }` |

To add a custom response for a specific prompt, modify `chatResponse()` in `server.ts`
to inspect the request body and return different content based on the messages.

## Adding a new spec

1. Create a file under `tests/<area>/my-feature.spec.ts`
2. Import from `../../fixtures/index.js` (not `@playwright/test` directly)
3. Use `authPage` fixture for any test that needs authentication
4. Use `api` fixture for direct HTTP calls
5. Run with `npm run test:e2e -- tests/<area>/my-feature.spec.ts`

## LEGION_BOOTSTRAP_PASSWORD outside of tests

The `LEGION_BOOTSTRAP_PASSWORD` env var is read by `LegionProcess.start()` when seeding a
fresh workspace. It sets the initial operator password deterministically instead of using a
random UUID. Useful for:
- Docker deployments where the password must be provided via env
- Scripted provisioning where you need to know the password in advance

When not set, a random UUID is used and printed to stdout in the bootstrap banner.
