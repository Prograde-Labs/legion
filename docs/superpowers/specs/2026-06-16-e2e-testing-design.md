# E2E Testing Design — Legion v2 Web Interface & Runtime

**Date:** 2026-06-16
**Status:** Approved

---

## Goals

- Achieve ~80% coverage of the core, runtime, and web packages through end-to-end tests
- Catch UI bugs (broken views, stale state, missing cleanup) that unit tests cannot detect
- Validate every API route and management tool call with full response shape assertions
- Verify view and component lifecycle — correct mount, unmount, and navigation behaviour
- Verify event system and WebSocket connection hygiene

---

## Constraints

- Local-only for this iteration; no CI workflow (GitHub Actions added later)
- No real LLM provider calls — a mock OpenAI-compatible HTTP stub handles all inference
- No chat UI yet — conversation tests cover list/view only, not message composition
- Node >= 20, ESM (`"type": "module"`), monorepo with npm workspaces

---

## Package Structure

A new `packages/e2e` workspace package. This follows the existing monorepo convention and keeps Playwright's dependency tree isolated.

```
packages/e2e/
├── package.json              # @playwright/test, typescript
├── tsconfig.json             # extends root tsconfig
├── playwright.config.ts      # baseURL, global setup/teardown, reporters
├── global-setup.ts           # spawns Legion server + mock LLM provider
├── global-teardown.ts        # kills both processes, removes temp dir
├── fixtures/
│   └── index.ts              # custom fixtures: apiClient, authenticatedPage
├── mock-provider/
│   └── server.ts             # OpenAI-compatible stub (models + chat completions)
├── helpers/
│   └── api.ts                # typed HTTP client used by apiClient fixture
└── tests/
    ├── auth/
    │   ├── login.spec.ts
    │   └── me.spec.ts
    ├── participants/
    │   └── participants.spec.ts
    ├── config/
    │   ├── providers.spec.ts
    │   └── credentials.spec.ts
    ├── conversations/
    │   └── conversations.spec.ts
    ├── events/
    │   └── events.spec.ts
    └── api/
        ├── health.spec.ts
        ├── execute.spec.ts
        └── websocket.spec.ts
```

The root `package.json` gets a new script:

```json
"test:e2e": "playwright test --config packages/e2e/playwright.config.ts"
```

---

## Runtime Changes

Three env vars are added to `packages/runtime/bin/legion.js` and `LegionProcess.ts` to make the server configurable without code changes:

| Env var | Default | Purpose |
|---|---|---|
| `LEGION_BOOTSTRAP_PASSWORD` | random UUID | Operator password used when seeding a fresh workspace. Bootstrap banner still prints the value. |
| `LEGION_WORKSPACE` | `process.cwd()` | Workspace root directory passed to `LegionProcess.start()`. Allows the server to use a temp dir without changing the working directory. |
| `PORT` | `3000` | HTTP port the server listens on. Allows E2E tests to use port `4000` without conflicting with a developer's local instance. |

All three have utility outside of testing (Docker deployments, multi-instance setups, scripted provisioning).

---

## Server Lifecycle

### `global-setup.ts`

Executes once before the entire test run:

1. Creates a temp workspace dir: `/tmp/legion-e2e-<timestamp>`
2. Spawns the mock LLM provider on port `4001`, waits for `GET /v1/models` to respond (max 10s)
3. Spawns the Legion server via `node packages/runtime/bin/legion.js` with:
   - `LEGION_BOOTSTRAP_PASSWORD=legion-e2e-test`
   - `LEGION_WORKSPACE=/tmp/legion-e2e-<timestamp>`
   - `PORT=4000`
4. Polls `GET /api/health` until it responds `{ status: "ok" }` (max 15s, 500ms interval)
5. Writes connection info to a well-known temp file so tests can read it:
   ```json
   { "serverUrl": "http://127.0.0.1:4000", "mockProviderUrl": "http://127.0.0.1:4001", "password": "legion-e2e-test" }
   ```

### `global-teardown.ts`

Executes once after the entire test run:

1. Sends SIGTERM to the Legion server process
2. Sends SIGTERM to the mock LLM provider process
3. Removes the temp workspace dir
4. Removes the temp connection info file

### Ports

| Service | Port |
|---|---|
| Legion server | 4000 |
| Mock LLM provider | 4001 |

Fixed ports (not randomised) since this is local-only. Teardown ensures they are freed before a new run.

---

## Custom Fixtures (`fixtures/index.ts`)

Two fixtures extend Playwright's base `test` object:

### `apiClient`

A typed wrapper around Playwright's `request` context. Provides:

```typescript
apiClient.login(name, password): Promise<{ token: string, participantId: string }>
apiClient.me(token): Promise<ParticipantInfo>
apiClient.execute(token, tool, args?): Promise<{ result: ToolResult, conversationId: string }>
apiClient.health(): Promise<{ status: string }>
```

Used directly in API-layer specs and internally by `authenticatedPage`.

### `authenticatedPage`

Calls `apiClient.login()` via the API (not through the UI form), injects the JWT into `localStorage`, then navigates to a given route. Every UI spec that requires auth uses this fixture — the login form flow is tested only once in `auth/login.spec.ts`.

---

## Mock LLM Provider (`mock-provider/server.ts`)

A minimal Node `http` server (no framework) implementing the OpenAI API subset the app uses:

| Endpoint | Response |
|---|---|
| `GET /v1/models` | `{ data: [{ id: "mock-model", object: "model" }] }` |
| `POST /v1/chat/completions` | Deterministic assistant message: `{ choices: [{ message: { role: "assistant", content: "mock response" } }] }` |

The mock provider URL (`http://127.0.0.1:4001`) is used in provider configuration tests. It returns valid enough responses for the app to accept a configured provider without errors.

---

## Helpers (`helpers/api.ts`)

Thin typed HTTP client. Handles:
- Base URL injection from the connection info file
- `Authorization: Bearer <token>` header
- JSON serialisation/deserialisation
- Typed response shapes matching the server's return types

Not a full SDK — just enough to eliminate repetitive `fetch` boilerplate across specs.

---

## Test Coverage Plan

### `api/health.spec.ts`
- `GET /api/health` returns `{ status: "ok" }` with no auth required

### `auth/login.spec.ts`
- Login form renders with name and password fields
- Valid credentials redirect to `/participants`
- Invalid credentials show an error message and stay on `/login`
- Unauthenticated access to any protected route redirects to `/login`
- Logout clears the session and redirects to `/login`
- After logout, navigating back to a protected route redirects to `/login`

### `auth/me.spec.ts`
- `GET /api/auth/me` with valid token returns correct `id`, `name`, `type`, `tools` array
- `tools` array contains all expected management tool names
- Request with no token returns 401
- Request with malformed/expired token returns 401

### `api/execute.spec.ts`

Every management tool is called directly via `POST /api/execute`. Each assertion validates the full response shape, not just `status: "success"`:

| Tool | Shape validated |
|---|---|
| `list_participants` | Array of `{ id, name, type, status }` |
| `list_tools` | Array of `{ name, description }`, count > 0 |
| `list_conversations` | Array (empty on fresh start) |
| `list_providers` | Array (empty on fresh start) |
| `list_credentials` | Array (empty on fresh start) |
| `configure_provider` | `{ status: "success" }`, provider appears in subsequent `list_providers` |
| `set_credential_with_meta` | `{ status: "success" }`, credential appears in subsequent `list_credentials` |
| `create_agent` | Returns new participant with `id`, `name`, `type: "agent"` |
| `modify_agent` | Returns updated participant |
| `retire_agent` | Target participant `status` becomes `"retired"` in subsequent `list_participants` |
- Calling any tool with no token returns 401
- Calling an unknown tool name returns `status: "error"` result

### `api/websocket.spec.ts`
- WebSocket connection at `ws://127.0.0.1:4000` is accepted with a valid token
- WebSocket connection is rejected (closed with error code) with no token or invalid token
- After a tool call via `/api/execute`, at least one event is received over the WebSocket within 2s

### `participants/participants.spec.ts`

**Mount/load:**
- Page loads, spinner resolves, table renders with at least the operator row
- Each row shows `name`, `type`, `status` columns

**CRUD:**
- "New participant" button opens the slide-over panel
- Filling and submitting the form creates the participant — it appears in the table without a page reload
- Slide-over closes cleanly after submit — no ghost DOM, no duplicate panels
- Clicking edit on a row re-opens the slide-over with pre-populated values
- Saving an edit updates the row in place
- Retiring a participant changes the status badge in the table
- Tool policy editor: toggling a tool policy and saving — the correct policy is returned by `list_participants` via API after save

**Navigation & lifecycle:**
- Navigating away to `/config` and back to `/participants` re-fetches data (table is not stale)
- Real-time update: retiring a participant via API causes the table to update automatically (WebSocket event triggers refresh)
- Loading state is shown while the initial fetch is in flight
- Error state renders if the tool call fails (not a blank view)

### `config/providers.spec.ts`

**Mount/load:**
- Providers tab renders with empty state message when no providers configured

**CRUD:**
- "Add provider" form: fill name, base URL (mock provider), model, credential — saves successfully
- New provider appears in the table with correct values
- Editing a provider updates the table row
- Provider with a missing/unset credential shows the correct visual indicator

**Navigation & lifecycle:**
- Switching between Providers and Credentials tabs does not lose state
- Navigating away and back re-fetches providers (no stale cache)

### `config/credentials.spec.ts`

**Mount/load:**
- Credentials tab renders with empty state message when no credentials set

**CRUD:**
- "Add credential" form: fill key name and secret value — saves successfully
- New credential appears in table with value masked
- Rotating a credential: new masked value is displayed

**Navigation & lifecycle:**
- Navigating away and back re-fetches credentials

### `conversations/conversations.spec.ts`

**Mount/load:**
- Page loads with empty state when no conversations exist
- After a `create_agent` + `communicate` tool call sequence via API, the new conversation appears in the sidebar

**Navigation:**
- Clicking a conversation in the sidebar loads the thread in the right panel
- URL updates to `/conversations/:id`
- Selecting a different conversation replaces the thread panel content
- Navigating away and back resets the selected conversation (no stale selection)
- Browser back button from a conversation returns to the unselected state

**Thread rendering:**
- Thread panel renders message blocks for the conversation
- Navigating away from `ConversationsView` and back does not duplicate conversations in the sidebar

### `events/events.spec.ts`

**Mount & WebSocket startup:**
- EventStreamView loads and the WebSocket connection is established
- Incoming events appear as rows in the table
- Row count increases as tool calls are made during the test

**Filters:**
- Category chips (message, tool, error, system) toggle correctly — rows outside the selected category are hidden
- Selecting multiple chips shows the union
- Clearing all chips restores all rows
- Free-text search filters visible rows by matching content
- Combining category chip and text search applies both filters

**Pause/resume:**
- Pausing stops new rows from appearing (events are buffered or dropped per design)
- Resuming restores row accumulation
- Pause/resume does not open a new WebSocket connection — the original connection is reused

**Row detail:**
- Clicking a row opens the detail panel with full event data
- Clicking a different row updates the detail panel
- The detail panel closes when expected

**Unmount & WebSocket cleanup:**
- Navigating away from `EventStreamView` closes the WebSocket connection
- Navigating back establishes a fresh connection — no duplicate connections
- After navigating away, no further event rows accumulate on the (now unmounted) view

---

## Coverage Target

~80% across `packages/core`, `packages/runtime`, and `packages/web`. The E2E suite covers the full request path — from UI interaction through HTTP/WebSocket to core business logic and back — so a single E2E test exercises multiple layers simultaneously.

Unit tests in Vitest continue to own isolated logic coverage. The E2E suite is additive, not a replacement.

---

## Documentation

A `packages/e2e/README.md` is included covering:
- Prerequisites (Node >= 20, built packages)
- Running the suite (`npm run test:e2e`)
- Running a single spec file (`playwright test tests/auth/login.spec.ts`)
- How to add a new spec
- How the mock LLM provider works and how to extend its responses
- The `LEGION_BOOTSTRAP_PASSWORD` env var and when to use it outside tests
