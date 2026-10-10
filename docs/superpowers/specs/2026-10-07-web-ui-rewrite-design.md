# Web UI Rewrite — Chat-First Interface

**Date:** 2026-10-07 · **Status:** approved design, pending implementation plan
**Scope:** `packages/web` rebuild + minimal backend tool additions (listed in §7)
**Supersedes:** in-flight `feat/user-management` worktree (abandoned; its scope folds in here)

## 1. Problem & goals

The current web UI is a management console. Day-to-day it is buggy, unintuitive,
visually dated and inconsistent, and it lacks user management. The rewrite makes
the interface **chat-first**: conversations are the home surface, with
Participants / Processes / Config as reachable top-level pages.

Success criteria:

- Chat is the landing route and the dominant daily surface.
- Forks, tool calls, and approvals read naturally inside a conversation.
- User management (create/edit users, passwords, approval authority) ships.
- One coherent visual system (command-deck dark default, blueprint light
  companion) with no raw colors in components.
- Mobile is a first-class layout, not an afterthought.
- The event-log concept is **not** carried forward.

Old features carry over only by re-earning their place in this spec — this is a
fresh feature list, not a port.

## 2. Non-goals

- **Artifacts.** Wanted eventually, but how they should surface in conversations
  is an open design question. Deferred to its own brainstorm. (See §9.)
- **Event log panel/page.** Deliberately dropped; a flawed shortcut not worth
  rebuilding. Conversation-scoped tool detail covers the legitimate uses.
- **Backend rework.** All collective operations remain ordinary authorized tool
  calls over `POST /api/execute` + WebSocket streaming. The only backend changes
  are the six tools in §7.

## 3. Architecture

### 3.1 Shell

Top navigation bar, icon + label tabs:

> 💬 Chat · 👥 Participants · 🗂 Processes · ⚙️ Config

- A **pending-approvals badge** (count) sits on the nav; clicking deep-links to
  the conversation holding the oldest pending approval.
- A **user avatar dropdown** (top right) opens the Account slide-over: change
  own password (`set_credential`, min 8 chars + confirm-match), session info,
  logout. Admin user management lives on the Participants page, not here.
- Chat is the home route (`/`); the other tabs are `/participants`,
  `/processes`, `/config`.

### 3.2 Layout

Desktop: three columns — conversation list (left), chat pane (center), right
dock (optional, opens on demand).

Mobile (<768px): the conversation list becomes an **off-canvas left drawer**
(hamburger toggle); the dock becomes a full-screen overlay with the same tab
strip; top nav collapses to icons with the badge retained.

### 3.3 State layer — functional composables (Vue-idiomatic)

No service/DI pattern. A thin foundation plus feature composables, each owning
module-scoped reactive state and exporting plain functions:

- `useLegionApi` — typed `execute()` wrapper, login/session handling, and the
  module-scoped WebSocket event bus (single connection, typed event emitter).
- `useConversations`, `useParticipants`, `useProcesses`, `useApprovals`,
  `useAuth`, `useTheme` — build on the foundation; compose with each other
  functionally.

The difference from today's code is coherence (one foundation instead of every
composable rolling its own fetch/stream logic), not a new paradigm.

### 3.4 Theming — Tailwind 4 token layer

- All color/spacing/radius/font decisions go through tokens declared in a
  Tailwind 4 `@theme` block (CSS variables); generated utilities reference the
  variables, so runtime switching is redefining variables under
  `[data-theme="…"]`. Zero extra dependencies — the repo is already on
  Tailwind 4.
- Two token sets: **command-deck** (default dark: near-black, cyan accent,
  JetBrains Mono for code/tool surfaces) and **blueprint-light** (its sibling:
  paper background, same cyan family, mono where it reads well).
- Components never use raw hex. User customization (accent hue, etc.) overrides
  individual CSS variables from JS.

### 3.5 Package structure

```
packages/web/src/
  views/        ChatView, ParticipantsView, ProcessesView, ConfigView (+LoginView)
  shell/        nav bar, drawers, dock frame, account slide-over
  chat/         thread, message parts, composer, fork controls, approval card
  panels/       dock tab strip + registered panel components
  renderers/    per-tool request/result component registry
  composables/  state layer (3.3)
  theme/        token sets, switcher, customization
  lib/          markdown/shiki/sanitize (carried over), ws client
```

## 4. Chat experience

### 4.1 Conversation list

Entries: name, participants, last-activity time, unread dot, pending-approval
marker. Sorted by recent activity; search/filter on top; "＋ New conversation"
pinned at the bottom. On mobile this column is the drawer.

### 4.2 Thread — typed message parts with a renderer registry

A message renders as a sequence of typed parts (text, tool-call, reasoning,
attachment). Each tool-call part resolves its component through a **registry
keyed by tool name** (extending the current `renderers/` pattern):

- `communicate` → sub-chat chip (opens the target conversation in a dock tab)
- file tools → file viewer panel
- shell/process tools → ANSI output block
- unknown tools → generic collapsible detail

Text parts render shared markdown (markdown-it + shiki + DOMPurify — carried
over from the current `lib/markdown.ts`).

### 4.3 Forks — inline only

Conversations are trees; sub-chats are **not** branches (they are `communicate`
tool calls). The only real forks are sibling messages (edit / re-run /
alternate replies):

- Where the active chain passes a message with siblings, an inline `‹ 1/2 ›`
  control renders at that message (ChatGPT-regenerate pattern).
- A fork marker chip lists sibling branch names and jumps to them.
- No header branch dropdown. Edit / re-run / create-branch live in each
  message's hover menu.

### 4.4 Composer

Textarea: send on Enter, Shift+Enter newline, @-mention autocomplete for
participants, tool hints scoped to the user's authorization, stop button while
streaming, and a branch indicator showing which chain a reply will land on.

### 4.5 Approvals

- Rendered **inline** as an interactive card at the point in the thread where
  the approval was raised: Approve / Reject with optional reason →
  `approval_response`.
- Global surfacing: the nav badge (count of pending approvals visible to this
  user), driven by the new `list_pending_approvals` runtime tool on load plus
  live `approval:requested` / `approval:resolved` WS chunks. Clicking the badge
  deep-links to the conversation.

### 4.6 Streaming

Token-by-token rendering with typing indicator; tool chips show a running
state; stop button routes through the existing cancel-stream path.

## 5. Right dock & panel system

### 5.1 Dock anatomy

A slide-in panel right of the chat pane (resizable, collapsible). Its tab strip
is **generic and dynamic** — tabs are instances (id, title, icon, payload),
never a hard-coded set:

- Clicking a tool chip / sub-chat chip pushes a tab from the registry (5.2).
- Tabs close (×), reorder by drag, and duplicates focus the existing tab.

Panel state (open tabs, order, width) persists per conversation in
localStorage. On narrow screens the dock takes the full viewport over the chat.

### 5.2 Tool→panel registry

The dock is driven entirely by a registry mapping tool names to panel
components that render that tool's **request and result**. Unknown tools fall
back to a generic detail panel. Initial registrations:

- `tool-detail` — inputs, status, timing, result (reusing renderer components
  inside the tab); the fallback for most tools.
- `communicate` — retrieves the target conversation and renders it with the
  outbound message and its reply **highlighted in context** (highlight layer
  over the same thread component used everywhere; which messages are
  highlighted depends on which chip was clicked). Live streaming included, with
  a jump-to-message breadcrumb back in the main thread.

Adding a panel for a new tool is one registry entry. No `event-log` panel — the
concept is deprecated (§2).

## 6. Management pages

### 6.1 Participants (master-detail)

Left: participant list — type badge (agent / user / service / operator),
status, model, last activity; searchable. Right: detail/editor pane rendering
per selected type:

- **Agent editor** — name, model, system prompt, tools/policies, middleware,
  approval authority (`create_agent` / `modify_agent` /
  `set_participant_middleware` / `set_approval_authority`).
- **User editor** — name, password set/reset (`set_credential`), identities
  read-only, operator flag, tool policies, approval authority, retire
  (`create_user` / `modify_user` / `retire_agent`). Retire hidden for
  protected participants, disabled for self and the last active operator.
- Services/mocks: view-only.

**Topology map** (new, this page): the collective as a diagram — agents,
services, MCP sources, connectors — with live edges from message activity.

### 6.2 Processes

Carried over on the new shell/state layer: process list, start form, detail
with live ANSI output. No feature additions.

### 6.3 Config

Carried over plus one new section:

- **Providers** (`list_providers` / `save_provider` / `delete_provider`) and
  **model routing** (`get_routing` / `save_routing`) as today.
- **MCP sources** (new): declare/edit MCP servers backed by the new
  `list_mcp_sources` / `save_mcp_sources` tools (§7), replacing hand-editing of
  `.legion/config.json`.

## 7. Backend exceptions (complete list)

The rewrite is web-only except for six new tools, all ordinary authorized tool
calls consistent with the v2 philosophy (no separate permission layer):

| Package | Tool                     | Purpose                                                                  |
| ------- | ------------------------ | ------------------------------------------------------------------------ |
| core    | `create_user`            | create user participants                                                 |
| core    | `modify_user`            | edit user participants                                                   |
| core    | `set_approval_authority` | set approval authority on any participant                                |
| runtime | `list_pending_approvals` | badge state across reloads (wraps `PendingApprovalRegistry.listPending`) |
| runtime | `list_mcp_sources`       | read MCP server declarations                                             |
| runtime | `save_mcp_sources`       | edit MCP server declarations                                             |

Notes: `set_credential` already exists (passwords); the operator's tool policy
must list the new tools for the web user; everything else the UI needs already
exists on main (verified: management, conversation, watch, provider/routing,
approval-response, cancel-stream, skill, usage tools).

## 8. Testing

- **Web unit tests** (vitest + happy-dom, run separately as today): composables
  (auth, conversations, approvals), renderer registry resolution, fork
  navigation, approval card actions, participant editors, panel registry &
  dock behavior, theme switching.
- **Type check:** `vue-tsc --noEmit`.
- **E2E (Playwright):** login → chat → tool chip opens dock tab → sub-chat
  highlight → fork arrows → approval approve/reject → user CRUD on
  Participants → MCP config round-trip.
- **New tools:** core/runtime tests for the six tools in §7.
- Gates before claiming done (unchanged): `npm run format:check` →
  `npm run typecheck` → `npm test` → web tests → `npm run test:e2e`.

## 9. Future directions (not in this rewrite)

- **Artifacts** — generated documents/files as first-class conversation
  objects. Open question to brainstorm separately: how should artifacts surface
  in conversations (inline? dock? both?) and where do they live?
- **Event-log removal** — the existing EventStream view dies with this
  rewrite; any residual server-side event-log affordances can be cleaned up
  later.
- **Theme customization UI** — a settings surface over the token-override
  mechanism (the mechanism ships in this rewrite, the UI can come later).

## 10. Migration & cleanup

- `packages/web` is replaced in-place on a rewrite branch; no parallel old/new
  UI period. `docs/mockups/` and `sketches/` remain as historical reference.
- The `feat/user-management` worktree (`/workspace/legion-user-mgmt`, 196 files
  of uncommitted changes) is **abandoned**; its spec inputs are absorbed here.
  The worktree and its uncommitted changes can be discarded once this spec is
  approved.
- Decisions of record: shell = top-nav tabs with icon treatment; panels =
  right dock, registry-driven; branching = inline arrows only; approvals =
  inline + nav badge; themes = command-deck + blueprint-light over one token
  layer; state = functional composables; participants = master-detail.
