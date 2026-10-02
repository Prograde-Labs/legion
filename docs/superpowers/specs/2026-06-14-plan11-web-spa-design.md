# Legion v2 — Plan 11: Web Management SPA Design

**Date:** 2026-06-14  
**Status:** Approved  
**Mockups:** `docs/mockups/` (login, participants, conversations, event-stream, configuration)

---

## 1. Scope

Plan 11 is a **read/manage console** — operators manage the collective and monitor what is happening. It is not a chat interface.

**In scope:**

- Login / auth flow
- Participants screen (list, create, modify, retire agents)
- Conversations screen (read-only monitoring, thread view)
- Event stream screen (live WebSocket feed)
- Configuration screen (Providers + Credentials)

**Explicitly out of scope (Plan 12):**

- Sending messages to agents / participating in conversations
- Approval handling UI (only relevant when a human is in the conversation loop)
- Dashboard / overview screen

**Backend gap — `modify_agent` tool:** Plans 1–10 define `create_agent`, `retire_agent`, `list_participants`, `get_conversation`, `set_tool_policy`, and `set_credential`. A `modify_agent` tool does not exist. Plan 11 must define and implement it. When `modify_agent` is available, `set_tool_policy` becomes redundant as a standalone tool (tool policy is one field within `modify_agent`). `set_tool_policy` is retained for backwards compatibility but the SPA does not expose it directly.

---

## 2. Tech stack

| Concern   | Choice                                                                |
| --------- | --------------------------------------------------------------------- |
| Framework | Vue 3 (Composition API, `<script setup>`)                             |
| Build     | Vite                                                                  |
| Styling   | Tailwind CSS v4                                                       |
| Routing   | Vue Router 4                                                          |
| State     | Singleton composables (no Pinia)                                      |
| HTTP      | native `fetch` (no SDK)                                               |
| WebSocket | native `WebSocket`                                                    |
| Utilities | VueUse (`useLocalStorage`, `useEventListener`)                        |
| Package   | `@legion-collective/web` — depends on `@legion-collective/types` only |

No Node-only dependencies may enter `@legion-collective/web`. Engine types that reference Node APIs stay in `@legion-collective/core`.

---

## 3. Visual design

### Colour palette

All colours are defined as Tailwind CSS custom config extensions. No raw hex values in components — use Tailwind utility classes throughout.

| Role                      | Tailwind class                  | Hex       |
| ------------------------- | ------------------------------- | --------- |
| Page background           | `bg-navy-950`                   | `#060d1a` |
| Sidebar / card background | `bg-navy-900`                   | `#0a1220` |
| Surface / panel           | `bg-navy-800`                   | `#0d1a30` |
| Border                    | `border-navy-600`               | `#1e3a5f` |
| Muted text                | `text-navy-400`                 | `#4b6a8a` |
| Accent (primary)          | `text-cyan-400` / `bg-cyan-400` | `#22d3ee` |
| Active / success          | `text-green-400`                | `#4ade80` |
| Warning / delegation      | `text-amber-400`                | `#f59e0b` |
| Error / danger            | `text-red-400`                  | `#f87171` |
| Body text                 | `text-slate-200`                | `#e2e8f0` |
| Secondary text            | `text-slate-400`                | `#94a3b8` |

### Typography

- UI: `font-sans` (system UI stack)
- Code / IDs / tool names / keys: `font-mono`
- Monospace used for: participant IDs, conversation IDs, tool names, credential key names, model names, base URLs

### Layout

- Persistent left sidebar: 200px fixed width
- Content area: `flex-1`, scrollable per screen
- Slide-over panels: 380–400px, slide in from right over dimmed content

---

## 4. Routing

```
/login                  → LoginView
/                       → redirect → /participants
/participants           → ParticipantsView
/conversations          → ConversationsView  (two-pane: list + thread)
/conversations/:id      → ConversationsView  (with specific thread selected)
/events                 → EventStreamView
/config                 → ConfigView  (Providers tab)
/config/credentials     → ConfigView  (Credentials tab)
```

All routes except `/login` require auth. The router guard checks for a valid JWT in Pinia auth store; redirects to `/login` if absent or expired.

---

## 5. Auth flow

1. User submits name + password to `POST /api/auth/login`
2. Server returns `{ token, participantId, expiresAt }`
3. Token persisted via VueUse `useLocalStorage` — survives page refresh. Acceptable for a localhost management console where XSS risk is negligible.
4. All subsequent `fetch` calls include `Authorization: Bearer <token>` header
5. WebSocket auth: first message sent after `open` event is `{ type: 'auth', token }`; server replies `{ type: 'connected', participantId }`
6. On 401 from any endpoint: clear auth store, redirect to `/login`
7. `GET /api/auth/me` called immediately after login to populate the auth store with the participant's display name and authority summary

---

## 6. Screens

### 6.1 Login (`LoginView`)

- Name + password fields, "Sign in" button
- Error state: "Incorrect name or password." inline below password field
- First-run hint: "Bootstrap password was printed to process stdout on startup."
- No registration, no forgot-password, no remember-me
- On success: redirect to `/participants`

### 6.2 Participants (`ParticipantsView`)

**List:** full-width table with columns: Status dot, Name, Model, Provider, Tools (count), Actions (Edit · Retire).

- Active participants: full opacity
- Retired participants: 35% opacity, dimmed, no Retire action (already retired)
- "Active" dot: `bg-cyan-400`; "Retired" dot: `bg-navy-500`
- "+ New agent" button top-right opens the create slide-over

**Slide-over (create / edit):** two tabs.

_Basic tab:_

- Name (text input; read-only on edit)
- Provider (select from configured providers; links to Config → Providers)
- Model (text input; overrides provider default)
- System prompt (monospace textarea)
- Max iterations (number input)

_Tool policies tab:_

- Default policy selector: Allow all / Require approval / Deny all (pill buttons; one active)
- Per-tool override list: rows of `[checkbox] [tool name] [require approval toggle] [× remove]`
  - Checked = tool explicitly enabled (policy: allow or require-approval)
  - Unchecked = tool denied regardless of default
  - "Require approval" pill toggles amber when active
  - Tools grouped by source: Built-in, then each MCP server by namespace (`mcp__<server>`)
  - "Add tool override" dropdown at bottom; lists available tools not yet in the list
- Tools absent from the override list fall back to the default policy

**Footer actions:**

- Retire button (danger, left-aligned) — confirm dialog before executing
- Cancel + Save (right-aligned)

**Backend calls:**

- List: `POST /api/execute` → `list_participants`
- Create: `POST /api/execute` → `create_agent`
- Modify: `POST /api/execute` → `modify_agent` _(new tool — see §9)_
- Retire: `POST /api/execute` → `retire_agent`
- Tool list (for dropdown): `POST /api/execute` → `list_tools` _(or derived from event stream)_

### 6.3 Conversations (`ConversationsView`)

**Layout:** two-pane split.

- Left pane (240px): conversation list, sorted newest-first. Each row: status dot, ID, participants, timestamp, first-message preview.
  - Active: cyan dot; Complete: green dot; Old: dim dot
- Right pane: thread view for selected conversation

**Thread view:**

- Header: conversation ID, participant list, status, message count, start time
- Live badge (pulsing cyan dot) when conversation is active
- Messages in chronological order, grouped by author
  - Author label colour: cyan for agents, violet for user participants
  - Timestamp per message
- Tool call blocks: collapsible, triggered by clicking the header row
  - Header: chevron, badge (tool call / result / delegation result / error), tool name, timestamp
  - "delegate" badge (amber) for `send_message` calls to other agents
  - Delegation blocks contain a nested sub-thread (amber left border) showing the delegated agent's messages and their own tool calls recursively
- Tool result rendering: dispatched through a renderer registry (see §7)
- Live "processing..." indicator (pulsing dot + italic text) when an agent turn is in progress
- Read-only footer noting this is a monitoring view

**Backend calls:**

- List conversations: `POST /api/execute` → `list_conversations` _(or derive from event stream)_
- Thread: `POST /api/execute` → `get_conversation`
- Live updates: WebSocket event stream filtered by `conversationId`

### 6.4 Event Stream (`EventStreamView`)

**Layout:** full-width log table + right detail panel (320px).

**Toolbar:**

- Live indicator (pulsing dot)
- Filter chips: message · tool · error · system (toggleable, multi-select)
- Free-text filter input (participant name or conversation ID)
- Pause / Resume button — stops auto-scroll and new row insertion while paused; resumes and catches up on resume

**Table columns:** Time · Event type badge · Detail (participant, tool, message preview) · Conv ID

**Event type badges:**

- `message:created` — cyan
- `tool:called` / `tool:completed` — violet
- `error` — red
- `conversation:started` / `participant:active` / system — muted

**Detail panel:** formatted JSON of the selected event payload. "Jump to conversation" link for events with a `conversationId`.

**New events:** fade-in animation from top, newest row at top (reverse chronological). Capped at 500 rows in DOM; older rows removed from bottom.

**Data source:** WebSocket event stream, all events. Filtered in the client.

### 6.5 Configuration (`ConfigView`)

Two tabs: **Providers** and **Credentials**.

_Providers tab:_

- Table: Name · Type badge · Base URL · Default model · Credential (ref chip) · Edit / Delete
- Type badges: `openai-compatible` (cyan), `anthropic` (amber), `copilot` / `codex` (muted)
- "+ Add provider" opens slide-over
- Provider slide-over fields: Name (read-only on edit), Type (select), Base URL (openai-compatible only), Default model, Credential key (select from existing credentials or "none")
- Backend: `POST /api/execute` → `configure_provider` / `list_providers` _(see §9 for new tools)_

_Credentials tab:_

- Table: Key name · Masked value (last 4 chars visible) · Used by (provider ref chip) · Last updated · Rotate / Delete
- "Rotate" (not "Edit") — values are write-only after save
- "+ Add credential" and "Rotate" open the same slide-over: key name (read-only on rotate), new value (password input), "used by" info panel
- "Saving takes effect immediately — no restart required."
- Backend: `POST /api/execute` → `set_credential` / `list_credentials` _(see §9)_

---

## 7. Tool renderer registry

Tool call results in the conversation thread are dispatched through a `ToolResultRenderer` Vue component that maps tool name patterns to display components. Fallback is always raw formatted JSON.

**Registry interface:**

```ts
interface RendererRegistration {
  pattern: string | RegExp; // matched against tool name
  component: Component; // Vue component
}
```

**Built-in renderers (Plan 11):**

| Pattern                   | Renderer               | Display                                  |
| ------------------------- | ---------------------- | ---------------------------------------- |
| `mcp__*__search`          | `SearchResultRenderer` | Cards: title, URL, snippet               |
| `mcp__filesystem__list_*` | `FileTreeRenderer`     | File/directory tree with icons and sizes |
| `mcp__filesystem__read_*` | `FileContentsRenderer` | Syntax-highlighted code block            |
| `*` (fallback)            | `JsonRenderer`         | Formatted, syntax-coloured JSON          |

**Renderer component interface:** receives `{ tool: string, args: unknown, result: unknown }` as props.

The registry is defined in `packages/web/src/renderers/index.ts` and injected app-wide via Vue's `provide/inject`. Custom renderers can be added without touching core components — this is the extensibility hook for Plan 12 and beyond.

The result block header always shows which renderer is active (small badge: "search renderer", "file renderer", "json") so the user knows when output is being interpreted rather than shown raw.

---

## 8. WebSocket integration

A single WebSocket connection is opened on login and torn down on logout or page close.

**Composable:** `useEventStream()` — returns a reactive event log and exposes `subscribe(handler)` / `unsubscribe()`.

**Connection lifecycle:**

1. Open `ws://<host>/ws`
2. On `open`: send `{ type: 'auth', token }`
3. On `connected` message: mark connected, begin emitting events
4. On `close` / `error`: exponential back-off reconnect (1s, 2s, 4s, max 30s); re-authenticate on each reconnect
5. On logout: `ws.close()`, clear reconnect timer

**Event routing:**

- `EventStreamView` subscribes to all events
- `ConversationsView` subscribes filtered by `conversationId` to update the active thread live
- `ParticipantsView` subscribes to `participant:active` / `participant:retired` to update status dots without a full reload

---

## 9. Backend requirements introduced by Plan 11

The following management tools do not exist in Plans 1–10 and must be added, either within Plan 11 or as a prerequisite task at the start of the plan.

| Tool                 | Purpose                                                                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `modify_agent`       | Update name, model, system prompt, max iterations, tool policies on an existing participant. Supersedes `set_tool_policy` for UI purposes.                                           |
| `list_tools`         | Return all registered tool names (for the "add tool override" dropdown in the participant slide-over).                                                                               |
| `list_conversations` | Return conversation summaries (ID, participants, status, message count, created timestamp). `get_conversation` returns a single thread; a list endpoint is needed for the left pane. |
| `list_providers`     | Return configured provider instances.                                                                                                                                                |
| `configure_provider` | Create or update a provider instance (name, type, baseUrl, defaultModel, credentialKey).                                                                                             |
| `list_credentials`   | Return credential key names, masked values, last-updated timestamps, and which providers reference them. Does not return plaintext values.                                           |

---

## 10. Package structure

```
packages/web/
  index.html
  vite.config.ts
  tailwind.config.ts
  tsconfig.json
  src/
    main.ts                  # createApp, router, pinia
    App.vue                  # RouterView + AppShell layout
    router/
      index.ts               # routes + auth guard
    composables/
      useAuth.ts             # singleton: token (useLocalStorage), participantId, login(), logout()
      useEventStream.ts      # singleton: WebSocket connection + subscription API
      useExecute.ts          # typed wrapper around POST /api/execute
    views/
      LoginView.vue
      ParticipantsView.vue
      ConversationsView.vue
      EventStreamView.vue
      ConfigView.vue
    components/
      layout/
        AppSidebar.vue       # persistent nav sidebar
      participants/
        ParticipantTable.vue
        ParticipantSlideOver.vue
        ToolPolicyEditor.vue
      conversations/
        ConversationList.vue
        ConversationThread.vue
        MessageBlock.vue
        ToolCallBlock.vue
        SubThreadBlock.vue   # recursive — renders nested agent delegation
      events/
        EventTable.vue
        EventDetailPanel.vue
      config/
        ProviderTable.vue
        ProviderSlideOver.vue
        CredentialTable.vue
        CredentialSlideOver.vue
      common/
        SlideOver.vue        # base slide-over container
        StatusDot.vue
        TypeBadge.vue
    renderers/
      index.ts               # registry + lookup function
      JsonRenderer.vue       # fallback
      SearchResultRenderer.vue
      FileTreeRenderer.vue
      FileContentsRenderer.vue
      ToolResultRenderer.vue # dispatcher
```

---

## 11. Key decisions

| Decision                    | Choice                                  | Rationale                                                                                                   |
| --------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Auth token storage          | `useLocalStorage` (VueUse)              | Survives page refresh; XSS risk negligible on localhost                                                     |
| State management            | Singleton composables, no Pinia         | Most state is server-side; shared global state (auth, WS) handled by module-level reactive() in composables |
| WebSocket                   | Single shared connection via composable | Avoids multiple competing connections; all views share the same stream                                      |
| Conversation thread nesting | Inline nested sub-threads               | Delegation tool calls contain the sub-agent thread inline; visual hierarchy via amber left border           |
| Tool renderer               | Registry + component dispatch           | Extensible without touching core components; JSON fallback always available                                 |
| Credential values           | Write-only (never returned after save)  | Prevents accidental exposure through UI; consistent with `CredentialStore` semantics                        |
| `modify_agent`              | New tool, folds in `set_tool_policy`    | Cleaner API; `set_tool_policy` retained for backwards compatibility                                         |
| Plan 12 boundary            | Chat interface + connector is separate  | Keeps Plan 11 focused; approval handling and message sending follow naturally                               |
