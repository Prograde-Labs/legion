# Design: OpenAI Codex login (ChatGPT plan usage) for Legion

**Date:** 2026-11-16
**Status:** Draft for review
**Scope:** Design only — no implementation in this change.

---

## Summary

Legion agents currently reach OpenAI only through an API key, which bills per token on
the OpenAI Platform. OpenAI also lets ChatGPT subscribers use their plan's included
usage windows for eligible inference. This spec adds that path to Legion as a new
**`codex` provider type**:

1. **Login** — the operator starts a device-code OAuth flow from the Legion web UI,
   approves it on any device, and Legion stores the resulting tokens locally.
2. **Inference** — the provider sends the same Responses-API-shaped requests Legion
   already speaks, but to the Codex backend with the OAuth token and account headers.
3. **Usage** — the provider exposes the ChatGPT plan's rate-limit windows
   (5-hour and weekly) so the UI can show remaining usage.
4. **Billing** — successful turns are recorded with `cost: 0`, because they draw from
   the ChatGPT plan rather than per-token API billing.

The wire mapping reuses `OpenAIResponsesProvider`; the new work is auth, credential
storage, login tools, and UI. No `ProviderConfig.type` union change is needed — `codex`
already exists and currently throws `NotImplementedError`.

**Why Codex device code rather than the official SIWC app flow:** the operator's browser
runs on a different LAN device from the Legion/Docker host. OpenAI's "Sign in with
ChatGPT" (SIWC) flow requires a loopback callback at `127.0.0.1:<port>/auth/callback`,
which would need an SSH tunnel or credential transfer on every login. Codex device code
needs no callback: Legion displays a URL and a one-time code, and the operator approves
it from any browser.

**Known limitation:** Codex login exposes the Codex model catalog (`gpt-5.x`), not the
full OpenAI API catalog. `gpt-4o-mini` and similar API-only models are not available on
this route. SIWC remains the future path for broader model access.

---

## Background: what Codex login is

Codex is OpenAI's coding agent. Its CLI supports three auth methods: ChatGPT browser
OAuth, ChatGPT device code, and an API key. Browser and device code both produce OAuth
tokens tied to the user's ChatGPT account; inference then goes to the Codex backend and
draws from the plan's usage allowance.

The protocol below is grounded in the open-source Codex client
(`openai/codex`, `codex-rs/login` and `codex-rs/core`) and verified against live
endpoints where noted.

### Device-code login

1. **Request a code** — `POST https://auth.openai.com/api/accounts/deviceauth/usercode`
   with JSON `{ "client_id": "app_EMoamEEZ73f0CkXaXp7hrann" }`. Returns
   `device_auth_id`, `user_code` (e.g. `MR1V-Q4QIL`), `interval` (seconds, string) and
   `expires_at`. Verified live against `auth.openai.com` while writing this spec.
2. **Show the user** — `https://auth.openai.com/codex/device` and the one-time code.
   The code expires in 15 minutes.
3. **Poll** — `POST https://auth.openai.com/api/accounts/deviceauth/token` with JSON
   `{ "device_auth_id", "user_code" }` every `interval` seconds. `403`/`404` means
   still pending; `200` returns `authorization_code`, `code_challenge`, `code_verifier`.
4. **Exchange** — form-encoded `POST https://auth.openai.com/oauth/token` with
   `grant_type=authorization_code`, `client_id`, `code`, `code_verifier`, and
   `redirect_uri=https://auth.openai.com/deviceauth/callback`. Returns `id_token`,
   `access_token`, `refresh_token`.

Device-code login must be enabled in the ChatGPT account's security settings
("Enable device code sign-in for Codex, Excel, PowerPoint, and Word") or by a workspace
admin. If it is disabled, the browser flow completes but no token is issued; the UI must
surface that clearly.

### Token refresh and revocation

- Refresh — JSON `POST https://auth.openai.com/oauth/token` with
  `{ "grant_type": "refresh_token", "client_id", "refresh_token" }`. Returns a new
  access token, a replacement refresh token, and a new ID token. Refresh tokens rotate;
  refreshes for one session must be serialized.
- Revoke — JSON `POST https://auth.openai.com/oauth/revoke` with
  `{ "token", "token_type_hint": "refresh_token", "client_id" }`. Best-effort on logout.
- Access tokens live ~1 hour; refresh tokens ~30 days and rotate on each refresh.

### Token claims

The ID token carries the account metadata:

| Claim path                                                    | Use                                   |
| ------------------------------------------------------------- | ------------------------------------- |
| `email` (top level) or `https://api.openai.com/profile.email` | display account                       |
| `https://api.openai.com/auth.chatgpt_account_id`              | required `chatgpt-account-id` header  |
| `https://api.openai.com/auth.chatgpt_plan_type`               | plan label (`plus`, `pro`, `team`, …) |
| `exp` (standard)                                              | access-token expiry                   |

### Codex inference backend

- Base URL: `https://chatgpt.com/backend-api/codex`
- Responses: `POST /responses`, stream-only (`stream: true` mandatory), SSE.
- Models: `GET /models` (Codex catalog format, not the public `/v1/models` shape).
- Usage: `GET https://chatgpt.com/backend-api/wham/usage`.

Required headers on every request:

```
Authorization: Bearer <access_token>
chatgpt-account-id: <account_id>
originator: codex_cli_rs
User-Agent: codex_cli_rs/<version>
OpenAI-Beta: responses=experimental
```

Request body (Responses API shape; the Codex client sends a superset):

```json
{
  "model": "gpt-5.5",
  "instructions": "You are ...",
  "input": [/* message / function_call / function_call_output items */],
  "stream": true,
  "store": false,
  "tools": [/* flat function tools */],
  "tool_choice": "auto",
  "parallel_tool_calls": false,
  "include": ["reasoning.encrypted_content"]
}
```

The backend rejects a missing/empty `instructions` (`{"detail":"Instructions are
required"}`). `temperature` and `max_output_tokens` are not part of the Codex client's
body and are dropped here.

---

## Current state in Legion (verified 2026-11-16, `main` `223f9be`)

- `packages/types/src/config.ts` L50 — `ProviderConfig.type` already includes
  `'codex'`. No union change needed.
- `packages/core/src/providers/SystemProviderStore.ts` L46–59 — `construct()` maps
  `'copilot'`/`'codex'` to `NotImplementedError`. `list()` L27–34 reads every key under
  `providers/` as a `ProviderConfig`; a sibling auth file would be misread.
- `packages/core/src/providers/OpenAIResponsesProvider.ts` — `stream()` builds a
  Responses body, fetches `${baseUrl}/responses` with `authHeaders(apiKey)`, parses SSE,
  maps usage, and yields one `done` chunk. `buildRequestBody` and `handleEvent` are
  private; the parse loop is embedded in `stream()`.
- `packages/core/src/providers/Provider.ts` L74–94 — `stream`, optional `listModels`,
  optional `pricingSource`. No usage surface.
- `packages/core/src/errors/LegionError.ts` L24–28 — `ProviderError` has no HTTP status,
  so a 401 cannot be distinguished for refresh-and-retry.
- `packages/core/src/storage/keyed-lock.ts` — `withKeyedLock` exists for serialized
  operations.
- `packages/runtime/src/server/runtime-tools.ts` — `SUPPORTED_PROVIDER_TYPES` allows
  `openai-compatible`/`openai-responses` only; `save_provider` advertises the same
  enum. `createRuntimeTools` receives `systemStore`, routing, approvals, auth, and MCP
  dependencies.
- `packages/runtime/src/LegionProcess.ts` — constructs `FileStorage(systemConfigDir)`
  and `SystemProviderStore(systemStorage)` (L231–235); `systemConfigDir` is
  `~/.config/legion` (L109).
- `packages/core/src/collective/default-participants.ts` — `MANAGEMENT_TOOLS` gives
  the bootstrap operator `auto` policy for runtime tools (`list_providers`,
  `save_provider`, …).
- `packages/web/src/components/config/ProviderSlideOver.vue` — type `<select>` offers
  two types; base URL and API key are shown for both. `save()` posts
  `{name, type, priority, baseUrl?, apiKey?}`.
- `packages/web/src/views/ConfigView.vue` — provider table (Priority, Name, Type,
  Base URL, API Key) and a `typeBadge` map that already includes `codex`.
- Deployment: `repos/legion-collective/deploy/docker-compose.yml` bind-mounts
  `config/providers` → `/home/node/.config/legion/providers`. Files in that directory
  persist across container recreation; other `~/.config/legion` paths do not.
- The real collective runs the Nov 9 image; this feature requires a rebuilt image (or
  `--dev` run) to take effect.

---

## Design answers

### Q1 — Provider type and config: reuse `'codex'`

Use the existing `codex` type. The config stays minimal:

```json
{ "name": "Codex", "type": "codex", "priority": 10 }
```

No `baseUrl` or `apiKey` is required. An optional `baseUrl` is honoured for tests and
self-hosted Codex-compatible endpoints. Precedence: config `baseUrl` >
`LEGION_CODEX_BASE_URL` > `https://chatgpt.com/backend-api/codex`.

- `SystemProviderStore.construct()` gains `case 'codex': return new CodexProvider(config, this.codexAuth)`.
- `SystemProviderStore` takes an optional `CodexAuthStore` in its constructor. When it
  is absent and a codex provider is requested, throw a clear `ProviderError`
  ("Codex auth store not configured").
- `SUPPORTED_PROVIDER_TYPES` and the `save_provider` enum gain `codex`.
- The web type dropdown gains `codex`; base URL and API key fields are hidden for it.

`SystemProviderStore.list()` must filter to keys ending in `.json` so the auth
subdirectory is not read as a provider config.

### Q2 — Credential storage: `providers/.codex-auth/<name>.json`

A dedicated `CodexAuthStore` writes one file per provider:

```
~/.config/legion/providers/.codex-auth/<name>.json
```

This location is inside the existing `config/providers` bind mount, so credentials
survive container recreation without a new mount. `SystemProviderStore.list()` skips the
directory because it filters to `.json` files.

File format (no tokens are ever returned by `list_providers` or logged):

```json
{
  "clientId": "app_EMoamEEZ73f0CkXaXp7hrann",
  "issuer": "https://auth.openai.com",
  "accountId": "user-…",
  "email": "user@example.com",
  "plan": "plus",
  "idToken": "…",
  "accessToken": "…",
  "refreshToken": "…",
  "expiresAt": 1790036132,
  "savedAt": "2026-11-17T05:00:00.000Z"
}
```

The store writes atomically (temp file + rename) with mode `0600`; the directory is
created `0700`. `CodexAuthStore` takes an absolute directory path (constructed by
`LegionProcess` from `systemConfigDir`), so it does not depend on `Storage` semantics
and is easy to test with a temp directory.

Refresh is serialized per provider with `withKeyedLock`, keyed by the auth file path.
`ensureFresh(name, force?)`:

1. Read the file; throw `ProviderError('Not signed in to ChatGPT')` if absent.
2. If `force` or `expiresAt - now < 300`, POST the refresh grant, save the replacement
   token set, and return it. If the refresh response omits `id_token`, retain the
   previous one and recompute `expiresAt` from the new access token.
3. Otherwise return the current auth.

Refresh failures with `invalid_grant`, `invalid_refresh_token`, `token_expired`,
`refresh_token_expired`, `refresh_token_invalidated`, or `refresh_token_reused` clear
the local tokens and surface "Sign in again".

### Q3 — Login flow: operator tools + web UI, device code

Five tools, registered in `createRuntimeTools` and added to `MANAGEMENT_TOOLS`:

| Tool                 | Args                          | Returns                                                                                                                                                  |
| -------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openai_login_start` | `{ providerName, priority? }` | `{ flowId, providerName, verificationUrl, userCode, intervalSeconds, expiresAt }` (`expiresAt` is an ISO 8601 string; `priority` defaults to `10`)       |
| `openai_login_poll`  | `{ flowId }`                  | `{ status: 'pending' }` or `{ status: 'complete', providerName, account: { email?, plan? } }` or `{ status: 'expired' }` or `{ status: 'error', error }` |
| `openai_auth_status` | `{ providerName }`            | `{ signedIn, email?, plan?, accountId?, expiresAt?, expired? }`                                                                                          |
| `openai_logout`      | `{ providerName }`            | `{ signedOut: true, revoked: boolean }`                                                                                                                  |
| `openai_usage`       | `{ providerName }`            | `ProviderUsageSummary`                                                                                                                                   |

`openai_login_start`:

1. Validate `providerName` with the same `[A-Za-z0-9._-]+` rule as provider configs.
2. Request a device code.
3. Store a pending flow in an in-memory `Map<flowId, PendingLogin>`:
   `flowId`, `providerName`, `priority`, `deviceAuthId`, `userCode`,
   `intervalSeconds`, `expiresAt`, `verificationUrl`. Parse `interval` from the
   string the endpoint returns and clamp it to a minimum of 5 seconds.
4. Return the display data.

`openai_login_poll`:

1. Look up the flow; if missing or expired, delete and return `expired`.
2. Poll the device-token endpoint once. `403`/`404` → `pending`.
3. On `200`, exchange the authorization code, extract claims, save the auth file, and
   `systemStore.save({ name: providerName, type: 'codex', priority })` if the provider
   does not already exist (or update its priority if provided). Delete the pending flow.
4. Return `complete` with non-secret account metadata.

Pending flows are in memory and expire after 15 minutes; a process restart loses an
in-progress flow but keeps completed credentials. The web UI polls every
`intervalSeconds` (minimum 5s) until terminal.

`openai_logout` reads the auth file, best-effort POSTs the revocation request, deletes the
file, and returns `revoked` reflecting whether the remote call succeeded. If no auth file
exists, it returns `{ signedOut: true, revoked: false }`. The provider config remains so
the operator can re-login without re-adding it.

### Q4 — Inference: subclass `OpenAIResponsesProvider`

Refactor `OpenAIResponsesProvider` minimally to expose hooks, with no behaviour change:

- `buildRequestBody(messages, tools, model)` → `protected`.
- Extract the SSE read/parse loop from `stream()` into
  `protected async *parseStream(res, options?)`, yielding `ProviderStreamChunk`s and
  throwing the same errors as today.
- Add `protected requestHeaders(): Record<string, string>` (default:
  `Content-Type` + `authHeaders(this.apiKey)`).
- Add `protected responsesUrl(): string` (default: `${this.baseUrl}/responses`).
- `ProviderError` gains an optional `status?: number`; the non-OK fetch path passes
  `res.status`.

`CodexProvider extends OpenAIResponsesProvider`:

- `stream()`:
  1. `auth = await authStore.ensureFresh(name)`.
  2. Build the body via `buildRequestBody`, then sanitize (below).
  3. `POST` with Codex headers.
  4. On `401`, `ensureFresh(name, true)` and retry once (only before any chunk was
     yielded).
  5. Non-OK → `ProviderError` with status and body snippet.
  6. `yield* parseStream(res)`, replacing the `done` chunk's `cost` with `0`.
- Body sanitization:
  - Drop `temperature` and `max_output_tokens`.
  - Fold any `{ role: 'system' }` input items into `instructions` (joined by blank
    lines); default `instructions` to `"Follow the user request."` when empty.
  - Add `parallel_tool_calls: false` and `include: ['reasoning.encrypted_content']`.
- Headers:
  - `Authorization: Bearer <accessToken>`
  - `chatgpt-account-id: <accountId>`
  - `originator: codex_cli_rs`
  - `User-Agent: codex_cli_rs/0.0.1`
  - `OpenAI-Beta: responses=experimental`
  - `Accept: text/event-stream`
  - `Content-Type: application/json`
- `listModels()`:
  - `GET {baseUrl}/models` with the same auth headers (JSON accept).
  - Parse `models[]` (fallback `data[]`): `slug`/`id`, `display_name`/`name`,
    `context_window`, `input_modalities`. Map to `ProviderModel`.
  - Return `[]` on failure, matching the existing best-effort contract.
- `usage()`:
  - `GET https://chatgpt.com/backend-api/wham/usage` with
    `Authorization`, `chatgpt-account-id`, `originator`, and `User-Agent`. The
    account header is required; if the stored auth lacks `accountId`, fail with a
    clear "sign in again" error.
  - Normalize and return `ProviderUsageSummary`.
- `pricingSource` is not overridden; `cost: 0` on the done chunk is authoritative.

The `Provider` interface gains an optional
`usage?(): Promise<ProviderUsageSummary>`.

### Q5 — Usage windows

`ProviderUsageSummary` (new in `packages/types/src/usage.ts`):

```ts
export interface ProviderUsageWindow {
  label: string; // "5-hour", "Weekly", or an additional-limit name
  usedPercent: number | null; // 0–100 as reported
  remainingPercent: number | null; // clamp(100 - usedPercent, 0, 100)
  windowSeconds: number | null;
  resetAt: number | null; // unix seconds
}

export interface ProviderUsageSummary {
  planType?: string;
  windows: ProviderUsageWindow[];
  credits?: {
    hasCredits: boolean;
    unlimited: boolean;
    balance: string | null;
  } | null;
  capturedAt: string;
}
```

Normalization from `wham/usage`:

| Response field                                                            | Output                                                                                         |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `plan_type`                                                               | `planType`                                                                                     |
| `rate_limit.primary_window` / `secondary_window`                          | one window each                                                                                |
| `additional_rate_limits[].rate_limit.primary_window` / `secondary_window` | additional windows, labelled by `limit_name`/`metered_feature`                                 |
| `window.limit_window_seconds`                                             | `windowSeconds`; label by duration (`18000` → 5-hour, `604800` → Weekly; otherwise hours/days) |
| `window.used_percent`                                                     | `usedPercent`; `remainingPercent = 100 - used`                                                 |
| `window.reset_at`                                                         | `resetAt` (unix seconds)                                                                       |
| `credits`                                                                 | `credits`                                                                                      |

`wham/usage` is an undocumented first-party route. If it fails (401/403/404/network),
`openai_usage` returns a `ProviderError`; the UI falls back to "Usage unavailable —
open ChatGPT settings" with the link. Inference still works. `openai_usage` returns a
`ProviderError` for a non-codex provider (or one whose provider class lacks `usage()`).

### Q6 — Web UI

`ProviderSlideOver.vue`:

- Add `codex` to the type `<select>`.
- For `codex`, hide base URL and API key. Show an **OpenAI ChatGPT plan** panel:
  - Not signed in: **Sign in with OpenAI** button.
  - Starting: display the verification URL and code, a copy button, and
    "Waiting for approval…"; poll `openai_login_poll` every `intervalSeconds`.
  - Complete: "Signed in as `<email>` · `<plan>`"; emit `saved` so the config view
    refreshes.
  - Signed in: show account/plan, the 5-hour and weekly windows (used/remaining and
    local reset time), **Refresh usage**, **Sign out**, **Re-sign in**, and
    **Manage usage** → `https://chatgpt.com/settings/usage`.
- The Save button still posts `{ name, type: 'codex', priority }`. Login may create the
  provider config on completion; either order works.

`ConfigView.vue`:

- Add a **Usage** column. For codex providers, render a compact summary
  (`5h 12% · 7d 40%`); for others, `—`.
- Show the account/plan under the provider name for codex rows.
- Add a **Manage usage** link near the table when any codex provider is present.
- Load status/usage after `list_providers`, best-effort; failures render as
  "Sign in to see usage".

The existing `typeBadge` map already has a `codex` entry.

### Q7 — Errors, security, and edge cases

**Errors**

- Missing auth → `ProviderError('Not signed in to ChatGPT')`; UI offers sign-in.
- Refresh failure → clear local tokens; message "ChatGPT session expired; sign in again".
- Device code disabled/expired → `openai_login_start`/poll returns a clear error;
  include the ChatGPT security-settings hint.
- `401` from inference → refresh once, then fail with "sign in again".
- `403` → surface the backend detail (workspace/region/policy).
- `429` → `ProviderError` including the body detail; UI links to ChatGPT usage settings.
- Non-OK HTTP → preserve status and a ≤200-char body snippet, matching existing
  provider error style.

**Security**

- Auth files are `0600`; directory `0700`.
- Tokens never appear in `list_providers`, tool results, logs, or the web UI.
- `openai_auth_status` returns only email/plan/account id/expiry.
- Logout attempts remote revocation, then clears local tokens even if revocation fails.
- Device codes and pending flows are held in memory and never persisted.
- Refresh is serialized per provider to avoid rotating-token races.

**Edge cases**

- Container restart mid-login: pending flow lost; auth files persist.
- Two Legion processes sharing the same auth file: keyed lock is per process; document
  that a single Legion instance should own a given provider's credentials.
- Codex CLI and Legion logging into the same account produce separate token sets; each
  refreshes its own, so they do not invalidate each other unless credentials are copied.

### Q8 — Testing

1. **Unit**
   - `CodexAuthStore.test.ts`: save/read/delete, atomic write, `0600`, rotation lock,
     missing/corrupt file handling.
   - `codex-auth.test.ts`: device-code request, pending/success polling, exchange body,
     refresh body, JWT claim extraction, revocation body.
   - `CodexProvider.test.ts`: URL, headers, body sanitization (dropped fields, folded
     system messages, default instructions), 401 refresh-and-retry, cost override,
     model catalog parsing, usage normalization, error status propagation.
   - `OpenAIResponsesProvider.test.ts`: existing tests must still pass after the
     parser extraction; add a test that `parseStream` is reusable.
2. **Runtime**
   - `runtime-tools.test.ts`: `save_provider` accepts `codex`; the five new tools
     behave correctly with a fake `CodexAuthStore` and mocked `fetch`; operator-only
     policy via `MANAGEMENT_TOOLS`.
3. **Web**
   - `ProviderSlideOver.test.ts`: codex option, hidden base URL/API key, sign-in
     panel, code display, polling, signed-in/usage rendering, logout.
   - `ConfigView.test.ts`: codex row renders account and usage; non-codex rows render
     `—`.
4. **Integration (opt-in)**
   - `CodexProvider.integration.test.ts`, gated by `LEGION_OPENAI_CODEX_INTEGRATION=1`
     and a credential file path in `LEGION_CODEX_AUTH_FILE`. Asserts one streamed text
     turn, one tool call, and a usage fetch. Documented in `docs/testing.md`.
5. **Manual smoke test**
   - After the first real login: one text turn, one tool call, one multi-turn recall,
     and one usage fetch. If the backend rejects the body, adjust `reasoning`, `text`,
     `client_metadata`, or input item shapes — this is the main unknown.

Gate order unchanged: `npm run format:check` → `npm run typecheck` → `npm test`
(+ web tests, since `packages/web` changes).

### Q9 — Test seams and routing

**Test seams** (constants in `CodexProvider`/`codex-auth.ts`, env-overridable so unit and
integration tests can point at mocks):

| Env var                  | Default                                      | Purpose                               |
| ------------------------ | -------------------------------------------- | ------------------------------------- |
| `LEGION_CODEX_CLIENT_ID` | `app_EMoamEEZ73f0CkXaXp7hrann`               | OAuth client ID                       |
| `LEGION_CODEX_BASE_URL`  | `https://chatgpt.com/backend-api/codex`      | inference/model base                  |
| `LEGION_CODEX_USAGE_URL` | `https://chatgpt.com/backend-api/wham/usage` | usage endpoint                        |
| `LEGION_CODEX_AUTH_FILE` | —                                            | integration-test credential file path |

These are read at construction/use time, not baked into the provider config.

**Routing:** Codex model IDs are not automatically distinguishable from other
providers' IDs. The operator should add an explicit route, e.g.
`{ "models": { "gpt-5.5": ["Codex"] } }` in workspace or system routing. Without it,
`ModelRouter.autoResolve()` calls `listModels()` on every provider for every turn —
which works, but adds a network round-trip to the Codex catalog on each resolution.
The web routing editor already lists provider names, so the Codex provider appears
there once configured.

---

## Implementation footprint

| File                                                       | Change                                                                       |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `packages/types/src/usage.ts`                              | add `ProviderUsageWindow`, `ProviderUsageSummary`                            |
| `packages/core/src/providers/Provider.ts`                  | add optional `usage?()`                                                      |
| `packages/core/src/errors/LegionError.ts`                  | `ProviderError` optional `status`                                            |
| `packages/core/src/providers/OpenAIResponsesProvider.ts`   | extract `parseStream`, make `buildRequestBody`/headers/URL hooks `protected` |
| `packages/core/src/providers/CodexProvider.ts`             | **new** — Codex backend provider                                             |
| `packages/core/src/providers/CodexAuthStore.ts`            | **new** — 0600 atomic credential store                                       |
| `packages/core/src/providers/codex-auth.ts`                | **new** — device flow, exchange, refresh, revoke, JWT claims                 |
| `packages/core/src/providers/SystemProviderStore.ts`       | construct `codex`; filter `list()` to `.json`                                |
| `packages/core/src/index.ts`                               | export new provider/auth modules                                             |
| `packages/runtime/src/server/runtime-tools.ts`             | allow `codex`; add five tools; accept `codexAuth` dep                        |
| `packages/runtime/src/LegionProcess.ts`                    | construct `CodexAuthStore`; pass to store and runtime tools                  |
| `packages/core/src/collective/default-participants.ts`     | add the five tools to `MANAGEMENT_TOOLS`                                     |
| `packages/web/src/components/config/ProviderSlideOver.vue` | codex option, sign-in panel, usage, logout                                   |
| `packages/web/src/views/ConfigView.vue`                    | codex account/usage column                                                   |
| `packages/core/src/providers/*.test.ts`                    | new/updated unit tests                                                       |
| `packages/runtime/src/server/runtime-tools.test.ts`        | new tool tests                                                               |
| `packages/web/src/**/*.test.ts`                            | updated UI tests                                                             |
| `docs/testing.md`                                          | `LEGION_OPENAI_CODEX_INTEGRATION=1` row                                      |

Untouched: `ModelRouter`, `AgentRuntime`, conversation storage, routing schema, and the
existing `openai-compatible`/`openai-responses` providers.

---

## Risks and open questions

1. **Undocumented Codex backend.** `/backend-api/codex/responses`, `/models`, and
   `/wham/usage` are first-party-internal routes, not public APIs. They can change. The
   design keeps them behind `CodexProvider` so a future switch to SIWC is isolated.
2. **Body compatibility.** The Codex client sends fields Legion does not
   (`reasoning`, `text`, `client_metadata`, `prompt_cache_key`). The first live smoke
   test may require adding one or more; the sanitizer is the single place to adjust.
3. **Model catalog.** Codex models only. If the operator needs `gpt-4o-mini` or other
   API-catalog models on the ChatGPT plan, that requires the SIWC route, which is out of
   scope here.
4. **Reasoning replay.** Encrypted reasoning items are not carried in `ProviderMessage`
   history, so multi-turn reasoning continuity is weaker than native Codex. This matches
   the existing Responses-provider limitation; a `ProviderMessage` extension is a
   follow-up.
5. **Header mimicry.** `originator: codex_cli_rs` and the Codex user agent are used for
   backend routing. They are constants in one place; if the backend accepts a Legion
   originator, switch it then.
6. **Device-code availability.** Requires the ChatGPT account/workspace setting. The UI
   must surface the setting when login stalls.
7. **Usage endpoint.** `wham/usage` is undocumented; the UI treats it as best-effort and
   always offers the ChatGPT settings link.
8. **Single owner.** Two Legion instances sharing one auth file can race refresh-token
   rotation across processes. Document one owner per provider.

## Self-review notes

- No placeholders: every tool, endpoint, header, and file is named.
- Consistency: the same `codex` type, auth path, header set, and tool names appear in
  every section.
- Scope: one provider type, one auth store, one login flow, one UI surface; SIWC,
  reasoning replay, and CLI login are explicitly out of scope.
- The `ProviderConfig` union does not change; `codex` already exists.
