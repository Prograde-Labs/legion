# Chat Interface Bugfixes & Agent-to-Agent Delegation — Design

**Date:** 2026-07-02
**Status:** Approved
**Scope:** Fix the bugs discovered during end-to-end testing of the Plan 12 chat interface, and make agent-to-agent communication work reliably by modeling delegation as nested sub-threads.

---

## 1. Overview

End-to-end browser testing of the chat interface (Plan 12) surfaced a cluster of bugs spanning three areas: authentication/session lifecycle, participant management (create/edit agent), and the core agent-to-agent communication feature, which stalls silently.

This document specifies fixes for the Critical, High, and Medium severity bugs. Low-severity display polish (sidebar hardcoded identity, approved-approval card rendering, Vite dev proxy) is deferred to a follow-up, except where a chosen fix resolves a display bug for free.

The centerpiece is **agent-to-agent delegation as sub-threads** (Part C): when an agent delegates to another agent, the target runs in a clean, separate child conversation linked back to the parent, rendered nested in the UI. This both fixes the stall and realizes the sub-thread design that was mocked up but never wired.

---

## 2. Goals

- Sessions expire correctly and a stale/expired token never leaves the user on a silently-broken screen.
- Creating and editing agents in the UI actually persists all fields (model, prompt, iterations, tool policies) to the source of truth and takes effect without editing files by hand.
- An agent can call `communicate` to another agent and reliably get an answer back, which it can summarize to the operator.
- Agent-to-agent delegations are visible in the UI, nested under the delegating tool call.
- Every fix is verified end-to-end in the browser against a known-fresh server process.

---

## 3. Out of Scope (Deferred to follow-up)

- **#8** Sidebar hardcodes "A / admin" regardless of the logged-in participant.
- **#9** Approved (vs rejected) approval cards never render in the thread.
- **#10** `npm run dev` has no `/api` + `/ws` Vite proxy, so dev mode can't reach the backend (production build is served by Fastify and works).
- Broader conversation-tree features (branching UI, compaction) — unrelated to these bugs.

---

## 4. Root-Cause Findings (Evidence)

Confirmed by reproducing on a known-fresh server process (PID verified new after restart):

1. **Agent-to-agent stall (#1, Critical).** operator → assistant → (`communicate`) → researcher. The assistant appends "What is N+N?" addressed to the researcher, then the conversation freezes at 3 messages: no LM Studio connection, no error, no response. The researcher works perfectly when called directly (returns real answers). The differentiator is that `communicate-tool.ts:32` computes `conversationId: conversationId ?? context.conversationId`, silently merging the delegated message into the caller's current conversation, so the researcher's `AgentRuntime` builds provider messages from the **parent's polluted history** (system + operator msg + the assistant's `list_participants` tool-call turn + the question). That payload stalls the provider call. This implicit-join is itself the core design defect (see §7.2), not merely the stall's proximate cause. Lock deadlock is ruled out: the operator→assistant call creates the conversation without holding its lock, so no shared lock is contended.

2. **Phantom sessions (#2, High).** `routes/auth.ts:44` returns `{token, participantId}` — never `expiresAt`. `useAuth.ts:29` reads the missing field (always `null`), so `isAuthenticated` treats the session as non-expiring and never decodes the JWT `exp`. After the 8h expiry — or any server restart (per-process random JWT secret) — the UI looks logged in while every request 401s.

3. **No redirect on 401 (#3, High).** `useExecute.ts` clears auth on 401 but does not navigate; the router guard is navigation-only, so the user is stranded on a broken view showing false empty-states ("No conversations yet"). The WebSocket treats every close identically and reconnects forever with the dead token (close code `4401` ignored).

4. **`modify_agent` writes to the wrong place (#4, Medium).** It persists to `.legion/agents/<id>.json`, but the running `Collective` reads `.legion/collective/participants/<id>.json` and `modify_agent` only syncs `name` into it. Model/prompt/policy edits silently never take effect.

5. **New-agent form drops the model (#5, Medium).** The Provider `<select>` in `ParticipantSlideOver.vue` binds to `providerId` initialized to `''` and never auto-selects the visibly-first option. `create_agent` receives `model: { provider: firstProvider, model: '' }` only if `providerId` happens to be set; in practice the model string is saved empty. It "works" only because LM Studio ignores the model string and serves whatever model is loaded.

6. **Edit form loads stale data + ignores default policy (#6, Medium).** Opening Edit reloads only `name` (from `list_participants`); model/prompt/iterations/policies retain leftover values from the previously-opened form, so saving corrupts config. The "Default policy" toggle is computed but never sent to the server.

---

## 5. Part A — Auth & Session (bugs #2, #3)

### 5.1 Server returns `expiresAt`

`POST /api/auth/login` (`packages/runtime/src/server/routes/auth.ts`) returns `expiresAt` — the JWT `exp` claim (seconds since epoch, `iat + 8h`). The token is already minted with `exp`; the handler surfaces that value in the response body alongside `token` and `participantId`.

### 5.2 Client honors expiry

`useAuth.ts`:
- Persist `expiresAt` from the login response (already wired; now non-null).
- `isAuthenticated` returns `false` once `Date.now() >= expiresAt * 1000`.
- Defense-in-depth: if `expiresAt` is absent for any reason, decode the JWT payload's `exp` claim client-side and use it. A token with no usable expiry that fails verification is handled by the 401 path below.

### 5.3 401 → logout + redirect

`useExecute.ts`: on any `401`, call `logout()` and navigate to `/login`. The composable gains access to the router (import the singleton router instance) so redirect works outside a component navigation event.

### 5.4 WebSocket auth-failure handling

`useWebSocket.ts`: inspect the close code. On `4401` (server auth-timeout/failure), stop the reconnect loop, call `logout()`, and redirect to `/login` rather than reconnecting forever with a dead token. Non-auth closes keep the existing exponential-backoff reconnect.

---

## 6. Part B — Participant Management (bugs #4, #5, #6)

### 6.1 Single source of truth for agent config

`create_agent` and `modify_agent` (`packages/core/src/tools/management-tools.ts`) both operate on the **collective participant record** — the in-memory `Collective` plus its persisted JSON at `collective/participants/<id>.json` — as the single source of truth. The dual-write to `.legion/agents/<id>.json` is removed.

- `modify_agent` updates `name`, `model` (as `ModelConfig`), `systemPrompt`, `maxIterations`, and tool policies on the collective record and persists via the collective's storage, then returns the updated participant.
- `create_agent` writes the same shape and no longer emits the divergent `agents/` file.
- Existing `agents/*.json` files are ignored by the runtime; no migration is required (the collective record is authoritative). We leave the stale files in place rather than deleting user data.

### 6.2 `get_participant` tool (new)

A new management tool `get_participant` returns a single participant's full configuration: `id`, `name`, `type`, `status`, and (for agents) `model` (`{provider, model}`), `systemPrompt`, `maxIterations`, and `tools` (the policy map). Added to the operator's `auto` tool policy.

This powers:
- The **Edit** slide-over, which loads the full config on open (fixing #6's stale-data bug).
- The **Participants table** Model/Provider columns (incidentally fixes display bug #7).

### 6.3 `ParticipantSlideOver.vue` fixes

- **Provider default (#5):** initialize `providerId` to `props.providers[0]?.name` when opening the New-agent form so the model isn't dropped.
- **Edit load (#6):** on open with a `participantId`, call `get_participant` and populate `name`, `model`, `providerId`, `systemPrompt`, `maxIterations`, `defaultPolicy`, and `overrides` from the returned config.
- **Default policy (#6):** include `defaultPolicy` in the `create_agent` / `modify_agent` payload so it is actually applied server-side.

### 6.4 Tool-policy payload shape

`create_agent` / `modify_agent` accept a `defaultPolicy` (`allow` | `require-approval` | `deny`) plus the per-tool `toolPolicies` override map. The server composes the final `tools` policy record: unspecified tools resolve to the default policy, overrides win per-tool. Policy string mapping stays consistent with the existing `AuthEngine` vocabulary (`auto` / `requires_approval` / `deny`), with the UI's `allow` mapping to `auto`.

---

## 7. Part C — Agent-to-Agent Delegation as Sub-Threads (bug #1)

### 7.1 Schema: parent link

`ConversationData` and `ConversationMeta` (`packages/types/src/conversation.ts`) gain:
- `parentConversationId?: string` — the conversation this sub-thread was spawned from.
- `parentToolCallId?: string` — the `communicate` tool-call id in the parent that created this sub-thread, so the UI can nest the sub-thread under the exact tool call.

Both fields are optional; top-level conversations leave them unset.

### 7.2 Delegation rule (backend)

**Core correction.** `communicate` must never join the caller's *current* conversation implicitly. The present behavior — `communicate-tool.ts:32` computes `conversationId: conversationId ?? context.conversationId` — is a genuine deviation from Legion's model: an unaddressed send silently merges into whatever thread the caller happens to be in. The rule is corrected universally, independent of participant type:

- **Explicit `conversationId` argument supplied** → join that conversation (opt-in continuation).
- **No `conversationId` argument** → **always create a new conversation.** The tool no longer substitutes `context.conversationId`.

This holds for every caller (agent, user, service). It is not scoped to agents.

**Parent linking.** When a new conversation is created this way *and the caller is itself currently in a conversation* (`context.conversationId` is a non-empty, real conversation id), the new conversation records:
- `parentConversationId = context.conversationId`
- `parentToolCallId = <the communicate tool call id>`

so the UI can nest it under the originating tool call. When the caller has no current conversation (e.g. the operator's first web message, where `context.conversationId` is the ephemeral `''`), the new conversation is top-level with no parent link — unchanged from today.

**Effect on the stall.** The target agent is now seeded only with the delegated message, so its `AgentRuntime` builds a **clean** provider context (system prompt + the single question) — the direct-call scenario that already works. This eliminates the stall and is a direct consequence of the corrected rule, not a special case.

**Sync semantics unchanged.** With no `replyTo`, the target's response returns as the `communicate` tool result, so the delegating agent summarizes it back to its own caller exactly as today. Human→agent chat (operator `communicate` with `replyTo`) is unaffected in behavior; it simply stops relying on the implicit-join that never applied to it anyway.

**Threading `parentToolCallId`.** `AgentRuntime`'s tool-execution loop knows the current tool call id; it passes that id into the `communicate` tool's context so the router can stamp it on the child. It travels via the tool context, not tool arguments (the LLM does not supply it).

### 7.3 Listing & fetching

- `list_conversations` excludes conversations where `parentConversationId` is set from the top-level list (sub-threads are not standalone list entries).
- `get_conversation` includes linked sub-threads for the requested conversation so the client can render them without extra round-trips. Shape: the response gains `subThreads: Record<string, ConversationData>`, keyed by `parentToolCallId`. Each entry is the full child conversation spawned by that `communicate` tool call. Messages with no delegation contribute no entries.

### 7.4 Frontend: nested rendering

Wire the existing-but-orphaned `ToolCallBlock.vue` / `SubThreadBlock.vue`:
- In `ConversationThread.vue` chat mode, when a message has a `communicate` tool call that produced a sub-thread, render a collapsible delegation block (`ToolCallBlock` with a `subThread`) showing the child conversation's messages nested with the amber left-border treatment from the mockup.
- `useConversation.ts` maps the `subThreads` returned by `get_conversation` onto the corresponding tool calls.
- Collapsed by default; expandable to reveal the delegated exchange.

### 7.5 Why this fixes the stall

The researcher receives a clean context (the actual cause of the provider stall) and runs in its own conversation with no lock contention with the parent. The synchronous tool-result return path is unchanged and already functions.

---

## 8. Part D — Verification

After each part, restart the server with a fresh process (`kill -9 <pid>` on the port owner, then `setsid nohup node packages/runtime/bin/legion.js`, confirming a new PID and `/api/health` OK) and test in the browser with Playwright:

- **A:** restart invalidates tokens → confirm the UI redirects to `/login` instead of showing false empty-states; log in fresh and confirm normal operation; confirm WS does not loop on a dead token.
- **B:** create an agent with a model via the UI → confirm `collective/participants/<id>.json` has the model and the table shows Model/Provider; edit it → confirm the form loads the real config and the change persists; confirm default policy is applied.
- **C:** operator → assistant → researcher round-trip → confirm the researcher answers, the assistant reports the answer to the operator, and the delegation renders as a nested sub-thread in the UI. Verify the top-level list does not show the sub-thread as a separate entry.

Each verification uses the `verification-before-completion` discipline: run the command / observe the browser, confirm the evidence, then claim success.

---

## 9. Affected Files (indicative)

**Backend:**
- `packages/runtime/src/server/routes/auth.ts` — return `expiresAt`.
- `packages/core/src/tools/management-tools.ts` — `create_agent`/`modify_agent` source-of-truth; new `get_participant`.
- `packages/core/src/collective/default-participants.ts` — operator `get_participant` policy.
- `packages/core/src/tools/communicate-tool.ts`, `packages/core/src/runtime/MessageRouter.ts`, `packages/core/src/runtime/AgentRuntime.ts` — delegation sub-thread creation + `parentToolCallId` threading.
- `packages/core/src/tools/*conversation*` — `list_conversations` filter, `get_conversation` sub-thread inclusion.
- `packages/types/src/conversation.ts` — `parentConversationId`, `parentToolCallId`, sub-thread response shape.

**Frontend:**
- `packages/web/src/composables/useAuth.ts`, `useExecute.ts`, `useWebSocket.ts` — session/expiry/redirect.
- `packages/web/src/components/participants/ParticipantSlideOver.vue` — provider default, full-config load, default policy.
- `packages/web/src/views/ParticipantsView.vue` — Model/Provider columns from `get_participant`/list.
- `packages/web/src/components/conversations/ConversationThread.vue`, `ToolCallBlock.vue`, `SubThreadBlock.vue`, `useConversation.ts` — nested sub-thread rendering.

---

## 10. Risks & Mitigations

- **Delegation rule breadth.** The corrected rule applies to all callers: no `conversationId` → new conversation, always. This is intentionally universal (§7.2) rather than scoped to agents. Human→agent chat is unaffected because the operator's first message already had an ephemeral (`''`) context and follow-ups pass an explicit `conversationId`; explicit `conversationId` remains the escape hatch for same-thread continuation. Any code path that *relied* on the implicit-join is being corrected deliberately.
- **`get_conversation` payload growth** from inlined sub-threads. Acceptable at current scale; sub-threads are typically short. Can move to lazy fetch later if needed.
- **Config source-of-truth switch (#4).** Leaving stale `agents/*.json` in place avoids destroying data; the runtime simply ignores them.
