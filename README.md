# Legion

A multi-agent collective framework — an always-on process that hosts AI agents, automated services, and human users who communicate by sending messages to each other.

## Overview

Legion is not a chat app you start and stop. It is a persistent process that external channels connect to simultaneously. Agents run autonomously, services react to events, and humans reach in through connectors (web browser, Teams, Slack) to direct, approve, or monitor. Any participant can talk to any other — a web user logged into the browser UI, an external integration, and an AI agent mid-task all participate through the same model.

### Key concepts

- **Participants** — Agents (LLM-driven), services (code modules), users (humans via connectors), and mocks (testing). Each has tool policies and approval authority profiles.
- **Conversations** — Persistent, branching message threads stored as key-value maps with full edit/prune/compaction history.
- **Communicate tool** — The primary inter-participant messaging mechanism, supporting both synchronous calls and fire-and-forget async dispatch via `replyTo`.
- **AuthEngine** — Pure policy resolver answering whether a tool call is `auto`, `requires_approval`, or `hidden` (absent from participant's tools map). Only tools explicitly listed in a participant's `tools` map are visible to the LLM. Approval requests bubble up the caller chain until reaching an authorized approver or boundary connector. If no authority is found, the call fails closed.
- **Connectors** — Channels that bridge participants to external entities (web, Teams, Slack). Authentication is connector-internal; core knows nothing about identity providers.
- **MCP tool sources** — External MCP servers register tools into a global registry, namespaced as `mcp__<server>__<tool>`.

## Quick start

```bash
# Prerequisites: Node.js >= 20

npm install
npm run build
npm start
```

On first launch Legion seeds a workspace (`.legion/`), creates a bootstrap operator participant, and starts the web server on `http://127.0.0.1:3000`. A random password is printed to stdout — use it to log in via the browser UI.

### Configuration

Workspace config lives at `.legion/config.json`:

```json
{
  "version": "2",
  "server": { "port": 3000, "host": "127.0.0.1" },
  "mcpServers": [ ... ]
}
```

Providers are system-wide. Configure one with the operator's `save_provider` tool, which writes
`~/.config/legion/providers/<name>.json`. Keep API keys out of workspace files. For example,
these tool arguments configure retries for a local provider:

```json
{
  "name": "local",
  "type": "openai-compatible",
  "baseUrl": "http://localhost:11434/v1",
  "priority": 10,
  "retry": { "maxRetries": 2, "baseDelayMs": 250, "maxDelayMs": 5000 }
}
```

By default, a transient failure can trigger **3 retries** after the initial attempt. Legion uses
exponential backoff with full jitter: each wait is chosen uniformly from zero up to a window
that starts at **500 ms** and doubles per retry, capped at **30000 ms**. A server-requested delay
is honored up to `maxDelayMs`. Retries stop once the provider has emitted content, so a partial
response is never replayed. Set `maxRetries` to `0` to disable retries.

On updates, omitting `retry` keeps the saved policy, including when editing in the web UI. Supplying
`retry` replaces the policy; omitted fields use their defaults, so `"retry": {}` restores all three
defaults. `maxRetries` must be between 0 and 10. Delay fields take nonnegative integers and cannot exceed 2147483647 ms. Fields other than `retry` are replaced as supplied, so include `apiKey` when editing a provider that uses one.

Each participant may set an optional `workspaceRoot` — a default base directory for its file and process tools, not a sandbox. It does not relocate `.legion/` storage, which always stays at the launch root. `WorkspaceConfig.workspaceRoot` supplies the default tool/process base when a participant does not set one.

### Environment variables

| Variable                    | Purpose                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------- |
| `LEGION_WORKSPACE`          | Override the workspace root directory                                                             |
| `LEGION_BOOTSTRAP_PASSWORD` | Set a deterministic password for the bootstrap operator (useful for Docker/scripted provisioning) |

### Docker

A multi-arch image (amd64/arm64) is published to GHCR: `edge` tracks main, `v*`
release tags get semver tags plus `latest`.

```bash
docker run -p 3000:3000 -v legion-data:/data \
  -e LEGION_BOOTSTRAP_PASSWORD=change-me \
  ghcr.io/prograde-labs/legion:edge
```

The workspace (conversations, participants, credentials, config) lives under
`LEGION_WORKSPACE` — mounted at `/data` so it survives container replacement.
To build locally: `docker build -t legion .`

## Architecture

```
packages/
  types/       — Shared TypeScript type definitions (tools, conversations, participants, config, events)
  core/        — Engine: runtimes, tools, auth, conversations, services, providers, storage
  runtime/     — Process entry point, Fastify HTTP server, WebSocket connector
  web/         — Vue 3 + Vite + Tailwind SPA (workspace management console)
  e2e/         — Playwright end-to-end tests
```

### Startup sequence

1. Read workspace config from `.legion/config.json`
2. Load the collective; seed bootstrap operator if none exists
3. Initialize `ConversationStore` and `CredentialStore` (file backends by default)
4. Register runtime factories for each participant type
5. Create core engine components (`EventBus`, `ToolRegistry`, `AuthEngine`, `MessageRouter`)
6. Register global tools (file ops, communicate, approval response, management tools)
7. Load MCP tool sources declared in workspace config
8. Create `ServiceManager`; build provider registry; register agent runtime factory
9. Initialize connectors; the web connector starts the HTTP server
10. Auto-start services with `autoStart: true`
11. Emit `process:ready`

### Management API

The web connector exposes an authenticated tool-execution gateway — every collective operation is a tool call, no bespoke CRUD endpoints:

| Route                   | Description                                           |
| ----------------------- | ----------------------------------------------------- |
| `POST /api/auth/login`  | Verify password, establish session (JWT)              |
| `POST /api/auth/logout` | Clear session                                         |
| `GET /api/auth/me`      | Authenticated participant info                        |
| `POST /api/execute`     | Execute a named tool as the authenticated participant |
| `GET /ws`               | Live event stream via WebSocket (authenticated)       |
| `GET /api/health`       | Process liveness check (unauthenticated)              |
| `GET /`                 | Vue SPA                                               |

## Participant types

| Type      | Driver                                  | Description                                       |
| --------- | --------------------------------------- | ------------------------------------------------- |
| `agent`   | LLM agentic loop                        | Calls tools, receives results, repeats until done |
| `service` | Code module (`LegionService` interface) | Reactive code-backed participant                  |
| `user`    | None (connector-driven)                 | Human user reached through a connector            |
| `mock`    | Scripted responses                      | Deterministic responses for testing               |

## Conversation model

Conversations are persistent, branching message histories. Messages form a tree via `parentId` links — the active chain is reconstructed by walking from `activeBranchHead` back to root. This structure supports:

- **Edit + re-run** — Create a new node replacing an old one; original marked `superseded`
- **Manual prune** — Mark messages `pruned`; excluded from active chain automatically
- **Compaction** — Replace a range of messages with a single summary node

All historical nodes remain in storage and are fully recoverable.

## Authorization & approval

`AuthEngine` resolves tool policies from the participant's `tools` map only. Tools absent from the map are hidden from the LLM entirely. When a call requires approval, the request bubbles up the caller chain until it reaches an authorized approver or a boundary connector (which posts to the external human). If no authority is found, the call fails closed.

## Service SDK

Any npm module can be a Legion service by exporting a `LegionService` object:

```typescript
export const service: LegionService = {
  async start(ctx) {
    /* ... */
  },
  async stop() {
    /* ... */
  },
  async onMessage(msg, ctx) {
    /* optional */
  },
};
```

Services get scoped storage, a `communicate()` method, and `callTool()` with auth enforcement.

## Development

Run backend and frontend together with live reload — no build step required:

```bash
npm install
npm run dev
```

- **Backend** (`packages/types`, `packages/core`, `packages/runtime`): executed directly by `tsx`. Any `.ts` file change restarts the process in ~1–2 s.
- **Frontend** (`packages/web`): Vite dev server runs embedded inside Fastify as middleware. Any `.vue` or frontend `.ts` change updates the browser instantly via HMR.

Both run on a single port (default `http://127.0.0.1:3000`) — no proxy, no cross-origin configuration needed.

### How it works

`npm run dev` calls `bin/legion.js --dev`, which:

1. Loads the backend directly from TypeScript source (via `tsconfig.dev.json` path aliases — no `dist/` build required)
2. Starts the Fastify server with Vite middleware instead of `@fastify/static`
3. Fastify routes (`/api/`, `/ws`) take priority; everything else falls through to Vite

Production startup (`npm start`) is completely unaffected — it continues to require a prior `npm run build`.

## Testing

### Unit / integration tests (Vitest)

```bash
npm test                  # run once
npm run test:watch        # watch mode
npm run test:coverage     # with coverage report
```

Integration tests are skipped by default. Enable them via environment variables — see [docs/testing.md](docs/testing.md).

### End-to-end tests (Playwright)

```bash
npm run test:e2e
```

Runs against a live Legion server with a mock LLM provider in an isolated temp workspace. See [packages/e2e/README.md](packages/e2e/README.md).

## Code conventions

- Pure ESM — always use `.js` extensions in imports
- TypeScript strict mode (`noUnusedLocals`, `noUnusedParameters`)
- Prettier: single quotes, semicolons, trailing commas, 100 char print width, 2-space indent
- Tests: Vitest with globals; unit tests as `*.test.ts`; integration tests as `*.integration.test.ts`
