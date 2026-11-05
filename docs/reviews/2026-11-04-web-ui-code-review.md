# Code Review — `integration/telegram-v2-and-web-ui` (Web UI rewrite + integration)

**Reviewer:** DeepSeek V4.1 Flash (OpenCode) · **Branch:** `integration/telegram-v2-and-web-ui` @ `cd6b85e` · **Date:** 2026-11-04

**Scope:** 194-file diff vs `main` (~20.7k insertions). Deep review of `packages/web` (127 files, ~7.2k non-test LOC + ~6k test LOC) plus the new backend surface the UI depends on: `create_user`/`modify_user`, `set_approval_authority`, `SecretStore`/`set_secret`/`list_secrets`, external connector loader, `OpenAIResponsesProvider`, runtime tools (`list_pending_approvals`, `list_mcp_sources`/`save_mcp_sources`, provider/routing), `LegionProcess` wiring, and the web connector/auth/execute paths.

**Method:** static review of source, tests, e2e specs, spec/plan docs, and live deployment behaviour. The test/build gates could not be run in the review environment (no Node/npm on host; the running image is production-pruned). Every finding below is from code reading; where a test masks the bug, that is called out.

## Verdict

The architecture is sound and the rewrite is a large improvement over the old console: fail-closed tool gating, sanitized markdown, a clean composable layer, and good unit-test volume. After the fix wave and the round-2 hardening pass it is **safe to use as the primary management surface for the reviewed scope**. The model picker, routing editor and dock restore no longer silently break configuration; live approvals and messages are wired through `watch_activity`/`watch_conversation` with a polling fallback for participants without the subscription tool; the streaming tools are viewer-scoped (`watch_conversation`/`watch_activity` require membership, `watch_conversations` filters to the caller, and the global activity feed is operator-only); and the privilege-escalation path is closed for user, agent and policy tools plus MCP saves (every `tools` mutation, `create_agent`/`modify_agent` tool maps, `set_tool_policy`, `remove_tool_policy`, `create_user`/`modify_user` policies and `save_mcp_sources` now require an operator). Users also receive `cancel_stream` so a conversation switch can stop the old stream. The remaining deferred items are documented below (approval matching by `toolCallId`, duplicate approval refreshes, overlapping-stream orphan, audit logging for MCP saves, and similar architectural follow-ups), and the e2e suite has still not been executed in this environment.

## Status legend

- `[ ]` not started · `[~]` in progress · `[x]` fixed and verified · `[-]` deferred/accepted

---

## High severity

### [x] H1. Agent model picker reads the wrong `list_models` shape

**Where:** `packages/web/src/views/AgentEditor.vue:37,104-106,193-201,229-231`
**What:** `list_models` returns `{ provider, model: ProviderModel }` where the id is `model.id` (`packages/runtime/src/server/runtime-tools.ts:106-113`, `packages/types/src/config.ts:58-65`). The UI types it as `{ model: { model: string } }` and renders `entry.model.model` → `undefined`.
**Impact:** the model dropdown contains blank options; editing an existing agent shows an empty model; saving can write an empty/invalid model. This is the same class of misconfiguration that broke the deployed agents.
**Why tests miss it:** `AgentEditor.test.ts:33-34` stubs `list_models` as `{ provider: 'openai', model: { model: 'gpt-4o' } }` — the fabricated shape hides the bug.
**Fix:** type/read `model.id`, group by `entry.model.id`, and add a test using the real `{ id, name }` shape. Validate the selected id against the list before save.

### [x] H2. Model routing editor never hydrates

**Where:** `packages/web/src/components/config/RoutingEditor.vue:14-16`; `packages/web/src/views/ConfigView.vue:17,38`
**What:** `RoutingEditor` snapshots `props.routing` once at setup. `ConfigView` starts with `systemRouting = {}` and fills it in `onMounted(load)` — after the child has already mounted. There is no watcher or `:key`.
**Impact:** Config → Model routing always renders empty on first visit; existing routing is invisible, and saving sends only the visible (empty) rows, which can wipe routing.
**Fix:** deep-watch `props.routing` and rebuild `rows`, or render the editor only after load, or key it on the loaded config. Add a hydration test; `ConfigView.test.ts` currently stubs `get_routing` with `data: []` and never asserts rows.

### [x] H3. Dock state is persisted but never restored

**Where:** `packages/web/src/panels/registry.ts:64-78,80`
**What:** `restore()` assigns `tabs.value = []` before reading localStorage; the module-level `watch([tabs, width], persist, { flush: 'sync' })` writes the empty state synchronously, then `getItem` reads back the value it just wrote.
**Impact:** per-conversation dock tabs/order/width are never restored (spec §5.1). The existing test (`registry.test.ts:42-49`) only asserts the write, not the restore.
**Fix:** read `raw` first, then assign; or add a `restoring` guard around `persist`. Add a restore test.

### [x] H4. “Re-run” is broken

**Where:** `packages/web/src/chat/MessageActions.vue:73-75`
**What:** calls `execute('generate', { conversationId })`; `generate` requires `agentId` (`packages/core/src/tools/management-tools.ts`, `required: ['conversationId','agentId']`) and returns an error when it is missing.
**Impact:** every Re-run menu action fails with “conversationId and agentId must be strings”.
**Fix:** pass an agent id (derive from the conversation/message) or let `generate` resolve the agent; add a regression test.

### [x] H5. Approvals and topology activity are not live

**Where:** `packages/web/src/composables/useApprovals.ts:40-49`; `packages/runtime/src/server/WebConnector.ts:26`; `packages/web/src/chat/Thread.vue` (no `watch_activity`); `packages/web/src/views/TopologyMap.vue:114-121`
**What:** `useApprovals` subscribes via `useLegionApi.onEvent('approval:requested'/'approval:resolved')`, but `WebConnector` never forwards `eventBus` events to WebSocket — it only sends `connected`, `message`, `pong`, and `stream:chunk` frames. `Thread` never subscribes `watch_activity`; `ChatView.vue:21-26` only refreshes approvals on mount. `TopologyMap` uses the same dead `onEvent('activity')` path.
**Impact:** the badge only populates when ChatView mounts; approvals raised while viewing a conversation do not appear until reload; topology live edges never light up. Spec §4.5/§6.1 not met. The approvals e2e works only because it arranges the approval before navigation (its own comment admits there is no websocket bridge).
**Why tests miss it:** `useApprovals.test.ts:44-60` calls `__handleEventForTests`, exercising the handler directly rather than the transport.
**Fix:** either forward approval/activity events from `eventBus` to WS in `WebConnector`, or subscribe `watch_activity` in Thread/AppShell; refresh the badge on AppShell mount; unsubscribe the TopologyMap handler.

### [x] H6. WebSocket lifecycle bugs (duplicate sockets, reconnect after logout)

**Where:** `packages/web/src/composables/useWebSocket.ts:20-26,71-104,108-120`
**What:**

- Module `connect()` always constructs a new `WebSocket`; exported `connect()` only guards `OPEN`, so a second call while `CONNECTING` leaks the first socket.
- `disconnect()` sets `stoppedByAuth = false` then calls `ws.close()`; the close handler schedules a reconnect, and the timer calls module `connect()` with no guard.
- The `error` handler closes the module-level `ws`, not the socket that errored, so a stale socket can close the new one.
- The close handler clears global `streamHandlers` for all sockets.

**Impact:** duplicate sockets and duplicate event delivery after reconnect/login; streams killed by a stale socket; reconnect attempts after logout.
**Fix:** guard against `CONNECTING`/`OPEN` and close the previous socket; track sockets per instance; suppress reconnect on intentional close; close `event.currentTarget` on error. Add tests for double connect and logout.

### [x] H7. Approval card can disappear without resolving; live args are empty

**Where:** `packages/web/src/chat/ApprovalCard.vue:22-35`; `packages/core/src/tools/approval-response-tool.ts:88-91,181`; `packages/web/src/composables/useApprovals.ts:28`
**What:** `approval_response` returns `status: 'success'` with per-decision outcomes including `unauthorized`, `not_found`, and `conflict`. `ApprovalCard.decide()` treats any success as resolved and emits `resolved`; `Thread.vue:116-118` removes the card locally. Separately, live `approval:requested` events set `args: {}` because the event payload has no args (`AgentRuntime.ts:475-480`).
**Impact:** an unauthorized user clicks Approve, the card vanishes, but the approval remains pending server-side. Live cards cannot show what is being approved, which is a security-relevant omission.
**Fix:** inspect `data.results` and only remove on `approve`/`reject`/`acknowledged`; surface other outcomes. Fetch args via `list_pending_approvals` or include them in the event.

### [x] H8. Cross-identity client state is not reset on logout

**Where:** `packages/web/src/App.vue:12-26`; module stores in `useApprovals.ts:13`, `useParticipants.ts:5`, `useConversations.ts:7-13`, `useReadState.ts:20`
**What:** logout resets only `useToolAccess`. Approvals, participants, conversations, active conversation, and read-state (localStorage `legion-last-read`) survive. `useApprovals` handlers are registered once and never removed.
**Impact:** after logout/login as another user (e.g. `limited-tester`), the previous user’s approvals, conversation list, participant list, and unread state remain visible until refreshed; stale badge counts; possible cross-identity data exposure.
**Fix:** add/reset methods for every module store and call them in `App.vue` on logout; scope read state per participant or clear it.

### [x] H9. Editor saves bundle tools the caller may not have

**Where:** `packages/web/src/views/AgentEditor.vue:118-159`; `packages/web/src/views/UserEditor.vue:127-180`
**What:** `AgentEditor` always calls `set_participant_middleware` after `create_agent`/`modify_agent`. `UserEditor` always calls `set_approval_authority` (and `set_credential` when a password is supplied) after `create_user`/`modify_user`. The save button is gated only by the primary tool.
**Impact:** a user granted only `modify_agent`/`modify_user` gets a `hidden` error after the primary write already succeeded → partial state and a misleading failure; retrying can duplicate-create. Spec §6.1 describes separate affordances.
**Fix:** gate each secondary call with its own `toolAccess.can(...)`, skip if hidden, or expose them as separate buttons. Make create idempotent/transactional.

### [x] H10. Operator flag can be self-granted; credentials are unscoped

**Where:** `packages/web/src/views/UserEditor.vue`; `packages/core/src/tools/user-tools.ts`; `packages/core/src/auth/AuthEngine.ts:9-18`; `packages/core/src/tools/management-tools.ts`; `packages/core/src/tools/secret-tools.ts`; `packages/runtime/src/server/runtime-tools.ts`
**What:** `create_user`/`modify_user` accept `operator: true`; `AuthEngine` authorizes by tool name only, and `Collective` only guards _removing_ the last operator. `set_credential`/`set_secret` can target any participant. Separately, `create_agent`/`modify_agent` accepted arbitrary `tools` maps and `save_mcp_sources` had no server-side guard, so a non-operator with those tools could grant `save_mcp_sources` and reach arbitrary command execution on the next boot.
**Impact:** a non-operator granted `modify_user`/`create_user`/`modify_agent` can promote themselves or grant privilege-bearing tools, then log in as an operator. Any holder of `set_credential` can reset any account’s password. This is privilege escalation.
**Fix:** user, agent and policy tool maps plus MCP saves are operator-gated server-side: granting `operator` in `create_user`/`modify_user`, any `tools` map in `create_user`/`modify_user`/`create_agent`/`modify_agent`, `set_tool_policy`/`remove_tool_policy`, and `save_mcp_sources` all reject non-operator callers. The web editor hides the operator checkbox and renders tool policies read-only for non-operators (with a preserved note) so a rename does not silently discard the policy map. `set_credential`/`set_secret` are scoped to self or an operator. Regression tests cover each non-operator rejection and the operator success paths.

---

## Medium severity

### [x] M1. Theme switching is unreachable and the light theme is broken

`useTheme.ts:25-29` `setTheme` is never called; no UI. Raw Tailwind colors (`text-slate-100`, `bg-cyan-700`, `text-amber-400`, `text-red-400`, `placeholder-slate-600`, etc.) in `ToolPolicyEditor`, `MiddlewareEditor`/`MiddlewareSchemaForm`, `SkillsSelector`, `SearchableCombobox`, `TypeBadge`, `StatusDot`, renderers, and `SlideOver` violate spec §3.4. `style.css:57-63,111-116,132-141` hardcodes white/black overlays, so tables/blockquotes are invisible on blueprint-light. Add a theme toggle in Account and replace raw colors with tokens.

### [x] M2. Tool hints are dead

`Composer.vue:38-44` reads `auth.tools`; `useAuth.ts` never fetches `/api/auth/me` and exposes no `tools`. `useToolAccess` already has `callerPolicy` but isn’t used. Spec §4.4/open question 4.

### [x] M3. AgentEditor middleware is half-wired

`AgentEditor.vue:268-273` passes `:skills="[]"` and `:credential-keys="[]"`, so skills/credential-reference fields are empty. `@validation` isn’t bound, so schema validation doesn’t block save.

### [x] M4. `ApprovalAuthorityEditor` drops `participants`

`ApprovalAuthorityEditor.vue:21-27` emits only `{ tools }`; `AgentEditor.vue:87-89` normalizes to `{ tools }` on load; saving erases any `participants` authority.

### [x] M5. Config error handling is inconsistent

`ConfigView.vue:53-56` deletes a provider without confirmation or error handling; `ProviderSlideOver.vue:35-55` and `RoutingEditor.vue:66-80` have no catch, so failed saves become unhandled rejections with no banner.

### [x] M6. Process actions have no error handling

`ProcessDetail.vue:62-90` `onSend`/`onStop`/`onDelete` have `try/finally` but no catch; failures reject silently. `ProcessesView.vue:11` ignores `loading`/`error`, so a denied list looks like “No processes yet”.

### [-] M7. `useToolStream` can hang on cancel and leaks on unmount

`useToolStream.ts:147-197` awaits `completion` with no timeout; if the terminal chunk never arrives, Stop hangs. `Thread.vue:141` and `useConversation.ts:129` use `cancelOnUnmount: false`, so dock sub-chats leave streams running after unmount.

**Status:** Deferred — needs a timeout contract for the terminal-chunk hang and unmount leak.

### [~] M8. MCP editor permits arbitrary command execution

`McpSourcesEditor.vue:86-107` sends arbitrary `command`/`args`; `runtime-tools.ts:206-253` validates only name/transport. Any user with `save_mcp_sources` auto can run arbitrary commands as the Legion user on next boot. Add confirmation/audit and restrict to operators.

**Status:** Client-side confirmation added before saving MCP sources and a server-side operator guard now rejects non-operator callers (`save_mcp_sources` returns an error before validating/persisting). Audit logging for MCP changes remains deferred.

### [-] M9. Security hardening gaps

No login rate limiting (`auth.ts:22-46`); JWT in localStorage (`useAuth.ts:10`); no CSP/security headers (`WebConnector.ts`); no token revocation on password change (`AccountSlideOver.vue:36-54`); `set_credential`/`set_secret`/`create_user` unscoped (see H10). Recommend rate-limit, CSP, HttpOnly/short-lived tokens, token versioning, target scoping.

**Status:** Deferred — JWT storage/revocation needs a larger auth change; rate limiting and CSP shipped.

### [x] M10. `list_pending_approvals` is unscoped

`runtime-tools.ts:168-189` returns every pending record; spec §4.5 says “visible to this user”. Filter by `authEngine.hasAuthority` or conversation membership.

### [x] M11. `TypeBadge` uses the wrong key map

`TypeBadge.vue:3-9` keys are `message:sent`, `tool:call`, etc.; `ParticipantsList.vue:52` passes `p.type` (`agent`/`user`/...), so every participant badge falls back to neutral. Fix the map (agent/user/service/mock).

### [x] M12. Mobile dock is not full-screen

`DockPanel.vue:38-41` combines `max-md:fixed max-md:inset-0` with inline `width: 420px`; width wins, so the overlay is 420px wide, not the full viewport (spec §3.2). Use `max-md:w-full` or conditional width.

### [x] M13. Jump-to-message is dead

`CommunicatePanel.vue:29-36` emits `jump`; `DockPanel.vue:74-78` doesn’t bind or emit it; `ChatView.vue:170-172` `onDockJump` is a no-op. Spec §5.2 breadcrumb not implemented.

### [x] M14. Login lands on `/participants`, not chat

`LoginView.vue:22`; spec §3.1 says Chat is home and the router redirects `/` → `/chat`. Pick one and update e2e.

### [~] M15. Stale e2e specs target the removed UI

`packages/e2e/tests/participants/participants.spec.ts` (table rows/slide-over), `config/providers.spec.ts` (“Provider instances available to agents”, default-model field), and `config/credentials.spec.ts` (`/config/credentials` route doesn’t exist). The Playwright config runs all `tests/`, so the full e2e gate will fail; these need deletion/rewrite.

**Status:** stale specs deleted (`participants.spec.ts`, `config/credentials.spec.ts`, and the legacy `/#/conversations` browser test in `middleware/middleware.spec.ts`); `config/providers.spec.ts` rewritten against the new Config page. The rewritten spec has not been executed — no Playwright browsers in the review environment — so verification is pending CI.

### [x] M16. Dead code remains

`composables/useConversation.ts` (298 lines) and `useConversation.test.ts` (382 lines) are unused; legacy `components/conversations/ConversationList.vue`, `components/conversations/ApprovalCard.vue`, `components/common/ApprovalBadge.vue`, and `renderers/ToolResultRenderer.vue` are unused. Plan Task 21 cleanup is incomplete.

### [-] M17. `useAuth` expiry is not reactive

`useAuth.ts:35-40` uses `Date.now()` with no timer; expiry won’t flip `isAuthenticated` until another reactive change. API 401 handles it, but the shell can show stale auth.

**Status:** Deferred — auth-expiry reactivity.

### [x] M18. AgentEditor “Save authority” on a new agent is invalid

`AgentEditor.vue:278-288` shows it for `participantId === 'new'` and calls `set_approval_authority` with `'new'` → “Participant not found”. Hide it for new.

### [x] M19. ChatView mobile drawer / reply target

`ChatView.vue:36-47` closes the drawer only when an id is selected, so “New conversation” leaves the drawer covering the draft. `ChatView.vue:131-138` always routes a reply to the first agent in a multi-agent conversation.

### [x] M20. Thread approval matching is imprecise

`Thread.vue:76-83` matches pending approvals to messages by tool name only; multiple approvals for the same tool duplicate cards or attach to the wrong message. Use approvalId/toolCallId when available.

### [-] M21. `useConversations` error handling and stream args

`useConversations.ts:44-58` uses `onChunk: () => void load()` with no catch (unhandled rejection if the tool is hidden); `getArgs` captures `filter.value.status` at start, so a status-filter change doesn’t restart the stream (no UI today).

**Status:** Deferred — conversations `onChunk` error handling and stale filter args.

### [~] M22. `SearchableCombobox` stale value and raw colors

`SearchableCombobox.vue:17,46-48`: `selectedLabel` is not synced from `modelValue`; raw `slate`/`cyan` colors; no keyboard navigation.

**Status:** Raw colors replaced with theme tokens; stale `selectedLabel` sync and keyboard navigation not addressed.

### [-] M23. `MiddlewareSchemaForm` array parsing

`MiddlewareSchemaForm.vue:106-110` splits arrays on commas; values containing commas are corrupted.

**Status:** Deferred — middleware array comma parsing.

### [-] M24. `ProcessStartForm` arg parsing

`ProcessStartForm.vue:29-32` splits on whitespace; args containing spaces cannot be expressed.

**Status:** Deferred — process arg whitespace parsing.

### [x] M25. `FileSecretStore` read-modify-write is not locked

`FileSecretStore.ts:59-77`; concurrent `setSecret` calls can lose updates. Use `storage.withLock`.

### [x] M26. Connector loader leaks started connectors on duplicates

`loader.ts:79-89` starts all connectors, dedupes by name; `LegionProcess.ts:580-591` skips registration on duplicate without calling `stop()`. A duplicate Telegram connector keeps polling.

### [~] M27. Provider type inconsistencies

`runtime-tools.ts:55` `save_provider` enum omits `openai-responses` while `ProviderSlideOver.vue:84-89` offers it; `SystemProviderStore.ts:36-46` maps `anthropic` to `OpenAICompatibleProvider` (Anthropic’s Messages API is not OpenAI-compatible) and throws for `copilot`/`codex` while the UI offers them. Implement, disable, or label unsupported types.

**Status:** Unsupported provider types disabled in the picker and `save_provider` enum; schema still advertises copilot/codex and `anthropic` remains labeled OpenAI-compatible.

### [x] M28. `FileCredentialStore.set` stores raw plaintext

`FileCredentialStore.ts:49-53`; it is unused — remove it to avoid a footgun.

### [~] M29. WebConnector minor issues

SPA fallback returns `index.html` for unknown `/api/*` (`WebConnector.ts:107-109`); a second `auth` frame while the first is pending can register twice (`219-245`); no WS heartbeat (Task 10 fixed the first two and deliberately omitted the heartbeat to avoid per-socket timer leaks in unit tests — follow-up).

**Status:** SPA fallback and double-auth fixed; WebSocket heartbeat omitted (per-socket timer leak follow-up).

### [x] M30. `execute` cancelStream has no ownership check

`execute.ts:48,58` and `cancel-stream-tool.ts`: a participant can cancel another stream if they know the UUID. Low likelihood, but validate ownership.

---

## Low severity / nits

- [x] L1. `AppShell` avatar dropdown doesn’t close on outside click/Escape.
- [x] L2. Router has no catch-all; unknown routes render blank.
- [x] L3. `Thread` streaming message sender is hardcoded `'assistant'`.
- [-] L4. `ChatView.onStreamSend` uses `void` without catch; `onCreated` calls `void store.load()` without catch. — Deferred: ChatView uncaught void promises.
- [-] L5. `Composer` clears the draft before the send is known to succeed; a failed send loses the text. — Deferred: needs a send-result contract before draft restore.
- [x] L6. `useProcess` doesn’t surface `procStream.error`; live output can silently stop.
- [x] L7. `useProcesses` polls every 5s regardless of visibility; `error` is ignored by the view.
- [x] L8. `TopologyMap` `role="button"` on `<g>` has no keyboard handler.
- [x] L9. `SlideOver` uses `text-slate-100`; light theme unreadable.
- [-] L10. `AccountSlideOver` changes the password without asking for the current one; existing JWTs remain valid. — Deferred: needs a backend verify-current-password tool.
- [x] L11. `LoginView` “bootstrap password printed to stdout” text may be stale.
- [~] L12. `ParticipantsView`/`ChatView` show no denied/empty-state message when the list tool is hidden. — ParticipantsView empty/denied state added; ChatView denied state not.
- [-] L13. No live participant subscription (`watch_participants` unused); status changes require reload. — Deferred: live participant subscription.
- [x] L14. `useReadState` localStorage is shared across users.
- [x] L15. Router guard doesn’t redirect authenticated users away from `/login`.
- [~] L16. No cache headers for hashed assets; no request logging. — Asset cache headers added; request logging not.
- [-] L17. Bootstrap password printed to stdout (existing; logs). — Deferred: bootstrap password printed to stdout.
- [x] L18. `SystemProviderStore.save` uses `config.name` directly in a path; boundary checks prevent traversal, but names with `/` create nested files invisible to `list()`.
- [x] L19. `save_provider` doesn’t validate `baseUrl` scheme (SSRF if a non-operator gets the tool).
- [-] L20. `OpenAIResponsesProvider` has no retry/timeout; minor. — Deferred: Responses provider retry/timeout hardening.
- [x] L21. `useTheme()` applies the theme as a side effect on every call; harmless but surprising.

---

## Spec conformance summary

| Spec item                     | Status                                                                                                                                                                                                                             |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §3.1 shell/nav/avatar/account | Done; theme switch in Account; login lands on Chat                                                                                                                                                                                 |
| §3.2 desktop/mobile           | Done; mobile dock is full-screen; drawer closes on new-conversation                                                                                                                                                                |
| §3.3 composables              | Done; dead `useConversation` removed; identity stores reset on logout                                                                                                                                                              |
| §3.4 token layer              | Done; tokens plus runtime theme switch; raw colours replaced                                                                                                                                                                       |
| §4.1 conversation list        | Done; unread client-only; no live participant subscription (deferred)                                                                                                                                                              |
| §4.2 typed parts/registry     | Partly; process/file panels still fall back to the generic tool-detail renderer                                                                                                                                                    |
| §4.3 forks                    | Done; index sync/error handling follow-up noted                                                                                                                                                                                    |
| §4.4 composer                 | Send/stop done; tool hints curated to user-facing tools; @mention basic                                                                                                                                                            |
| §4.5 approvals                | Inline + badge; live viewer-scoped `watch_activity`/`watch_conversation`; args refreshed; outcome handling fixed; polling fallback for non-operators (global feed is operator-only)                                                |
| §4.6 streaming                | Text/reasoning done; thinking indicator added; stop can still hang on a missing terminal chunk (deferred)                                                                                                                          |
| §5.1 dock                     | Tabs/close/reorder done; persistence restore fixed; mobile width fixed                                                                                                                                                             |
| §5.2 registry                 | communicate + fallback done; jump breadcrumb wired; process/file panels missing                                                                                                                                                    |
| §6.1 participants             | List/editors done; model picker fixed and save-validated; operator/tool escalation closed across user, agent and policy tools; tool policies read-only for non-operators; middleware skills/credentials wired; topology edges live |
| §6.2 processes                | Carried over; error handling surfaced                                                                                                                                                                                              |
| §6.3 config                   | Providers/routing/MCP done; routing hydrates on load; provider saves narrowed to constructible types                                                                                                                               |
| §7 backend tools              | Implemented; `list_pending_approvals` scoped; `save_provider` enum matches the store; tool-policy mutations and MCP saves operator-gated; watch streams viewer-scoped                                                              |
| §8 testing                    | Unit/web tests plentiful and green; rewritten e2e specs not executed here (Playwright browsers unavailable — pending CI)                                                                                                           |

## Test gaps

The gaps identified during the review are now covered by regression tests:

- Dock restore (including non-array persisted `tabs`) is tested.
- `AgentEditor` reads the real `list_models` `{ provider, model: { id, name } }` shape, validates the selected id, and loads model/middleware lists for new agents.
- `RoutingEditor` has a hydration test.
- Re-run passes `agentId`.
- Double WS connect, intentional disconnect and stale-socket close are tested.
- Approval live delivery is tested through the `watch_activity` transport chunk path, plus the `list_pending_approvals` fallback when the stream is hidden.
- Identity-switch state reset is covered across the module stores.
- Approval `unauthorized` outcome handling is covered.
- `ApprovalAuthorityEditor` preserves `participants`.
- Middleware validation blocks save; skills/credential hydration is tested.
- Non-operator `modify_user` self-granting `save_mcp_sources` is rejected; non-operator `set_tool_policy`/`remove_tool_policy` are rejected; operator paths succeed.
- Non-operator `create_agent`/`modify_agent` with a `tools` map are rejected (agent without tools still succeeds); non-operator `save_mcp_sources` is rejected and the operator path persists.
- `watch_conversation` rejects non-participants/non-existent conversations and lets operators watch any; `watch_conversations` scopes non-operators to their own conversations; `watch_activity` rejects the global feed for non-operators and rejects non-member conversation filters.
- Boot/user grants include `cancel_stream`; `useToolStream.start()` starts the next stream even when `cancel_stream` is denied; AppShell stops the approvals polling fallback when `watch_activity` recovers.
- `create_user` merges the subscription tool defaults; `UserEditor` renders tool policies read-only for non-operators; Thread surfaces a denied conversation stream as a non-blocking note.
- Provider saves reject `anthropic`/`copilot`/`codex` and advertise only `openai-compatible`/`openai-responses`.

Remaining gaps:

- The rewritten e2e specs (`config/providers`, etc.) have **not been executed**: the Docker wrapper mounts an ephemeral `HOME`, Playwright browsers are not installed in this environment, and they were intentionally not added. Verification is pending CI.
- Approval-to-message matching still uses tool name because the approval record has no `toolCallId` backend field; a test for the precise match cannot be written until the field exists (parked).
- The overlapping-start orphan (a failed cancel leaves the old transport subscription registered until its generation is superseded) is an architectural follow-up (parked); the viewer-scoping tests cover the data-exposure side.

## Strengths worth preserving

- Fail-closed tool gating: `useToolAccess.can()` returns `hidden` before the first fetch lands, and `refresh()` drops stale responses across logout.
- Markdown is sanitized (`html: false` + DOMPurify; `ansi_up` escapes HTML by default).
- Good unit-test volume (51 files, ~6k lines) and e2e coverage of the main journeys.
- Narrow connector runtime deps (no event bus) and a log-and-skip loader that never kills boot.
- Encrypted secret store: AES-256-GCM, random IV, scrypt-derived key, plaintext never returned by tools.
- The tool-call architecture is respected — no CRUD REST endpoints were added.
- Thoughtful inline comments explain decisions, even where they are now stale.

## Fix tracking

The implementation plan is at `docs/superpowers/plans/2026-11-04-web-ui-review-fixes.md`. The fix wave is complete, including a final whole-branch review pass that closed the tool-policy self-escalation path, added live `watch_conversation` delivery, curated composer hints, narrowed provider types, fixed editor gating and applied the remaining nits. A round-2 hardening pass then granted `cancel_stream` (with failed-cancel tolerance), viewer-scoped the `watch_*` streams, closed the same escalation route through `create_agent`/`modify_agent` and `save_mcp_sources`, merged subscription defaults into `create_user`, and applied the related UX/test-hygiene nits. Every finding has a status — `[x]` fixed and covered by unit/web tests, `[~]` partially fixed with the remaining work noted inline, or `[-]` deliberately deferred with a reason. The full gate (`format:check`, `typecheck`, `npm test`, web tests) is green. The e2e suite could not be executed in this environment: the Docker wrapper mounts an ephemeral `HOME`, so Playwright browsers are not present, and they were intentionally not installed; the rewritten web UI specs remain pending CI.
