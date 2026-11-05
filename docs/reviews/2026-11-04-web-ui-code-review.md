# Code Review — `integration/telegram-v2-and-web-ui` (Web UI rewrite + integration)

**Reviewer:** DeepSeek V4.1 Flash (OpenCode) · **Branch:** `integration/telegram-v2-and-web-ui` @ `cd6b85e` · **Date:** 2026-11-04

**Scope:** 194-file diff vs `main` (~20.7k insertions). Deep review of `packages/web` (127 files, ~7.2k non-test LOC + ~6k test LOC) plus the new backend surface the UI depends on: `create_user`/`modify_user`, `set_approval_authority`, `SecretStore`/`set_secret`/`list_secrets`, external connector loader, `OpenAIResponsesProvider`, runtime tools (`list_pending_approvals`, `list_mcp_sources`/`save_mcp_sources`, provider/routing), `LegionProcess` wiring, and the web connector/auth/execute paths.

**Method:** static review of source, tests, e2e specs, spec/plan docs, and live deployment behaviour. The test/build gates could not be run in the review environment (no Node/npm on host; the running image is production-pruned). Every finding below is from code reading; where a test masks the bug, that is called out.

## Verdict

The architecture is sound and the rewrite is a large improvement over the old console: fail-closed tool gating, sanitized markdown, a clean composable layer, and good unit-test volume. It is **not yet safe to treat as the sole management surface**. Three UI paths can silently break agent configuration (model picker, routing editor, dock restore), the live approval/activity story is not actually wired, and there are privilege-escalation and identity-isolation gaps. The deployed agents currently work only because the config was fixed by hand; using the UI to edit an agent would reintroduce the broken-model problem.

## Status legend

- `[ ]` not started · `[~]` in progress · `[x]` fixed and verified · `[-]` deferred/accepted

---

## High severity

### [ ] H1. Agent model picker reads the wrong `list_models` shape

**Where:** `packages/web/src/views/AgentEditor.vue:37,104-106,193-201,229-231`
**What:** `list_models` returns `{ provider, model: ProviderModel }` where the id is `model.id` (`packages/runtime/src/server/runtime-tools.ts:106-113`, `packages/types/src/config.ts:58-65`). The UI types it as `{ model: { model: string } }` and renders `entry.model.model` → `undefined`.
**Impact:** the model dropdown contains blank options; editing an existing agent shows an empty model; saving can write an empty/invalid model. This is the same class of misconfiguration that broke the deployed agents.
**Why tests miss it:** `AgentEditor.test.ts:33-34` stubs `list_models` as `{ provider: 'openai', model: { model: 'gpt-4o' } }` — the fabricated shape hides the bug.
**Fix:** type/read `model.id`, group by `entry.model.id`, and add a test using the real `{ id, name }` shape. Validate the selected id against the list before save.

### [ ] H2. Model routing editor never hydrates

**Where:** `packages/web/src/components/config/RoutingEditor.vue:14-16`; `packages/web/src/views/ConfigView.vue:17,38`
**What:** `RoutingEditor` snapshots `props.routing` once at setup. `ConfigView` starts with `systemRouting = {}` and fills it in `onMounted(load)` — after the child has already mounted. There is no watcher or `:key`.
**Impact:** Config → Model routing always renders empty on first visit; existing routing is invisible, and saving sends only the visible (empty) rows, which can wipe routing.
**Fix:** deep-watch `props.routing` and rebuild `rows`, or render the editor only after load, or key it on the loaded config. Add a hydration test; `ConfigView.test.ts` currently stubs `get_routing` with `data: []` and never asserts rows.

### [ ] H3. Dock state is persisted but never restored

**Where:** `packages/web/src/panels/registry.ts:64-78,80`
**What:** `restore()` assigns `tabs.value = []` before reading localStorage; the module-level `watch([tabs, width], persist, { flush: 'sync' })` writes the empty state synchronously, then `getItem` reads back the value it just wrote.
**Impact:** per-conversation dock tabs/order/width are never restored (spec §5.1). The existing test (`registry.test.ts:42-49`) only asserts the write, not the restore.
**Fix:** read `raw` first, then assign; or add a `restoring` guard around `persist`. Add a restore test.

### [ ] H4. “Re-run” is broken

**Where:** `packages/web/src/chat/MessageActions.vue:73-75`
**What:** calls `execute('generate', { conversationId })`; `generate` requires `agentId` (`packages/core/src/tools/management-tools.ts`, `required: ['conversationId','agentId']`) and returns an error when it is missing.
**Impact:** every Re-run menu action fails with “conversationId and agentId must be strings”.
**Fix:** pass an agent id (derive from the conversation/message) or let `generate` resolve the agent; add a regression test.

### [ ] H5. Approvals and topology activity are not live

**Where:** `packages/web/src/composables/useApprovals.ts:40-49`; `packages/runtime/src/server/WebConnector.ts:26`; `packages/web/src/chat/Thread.vue` (no `watch_activity`); `packages/web/src/views/TopologyMap.vue:114-121`
**What:** `useApprovals` subscribes via `useLegionApi.onEvent('approval:requested'/'approval:resolved')`, but `WebConnector` never forwards `eventBus` events to WebSocket — it only sends `connected`, `message`, `pong`, and `stream:chunk` frames. `Thread` never subscribes `watch_activity`; `ChatView.vue:21-26` only refreshes approvals on mount. `TopologyMap` uses the same dead `onEvent('activity')` path.
**Impact:** the badge only populates when ChatView mounts; approvals raised while viewing a conversation do not appear until reload; topology live edges never light up. Spec §4.5/§6.1 not met. The approvals e2e works only because it arranges the approval before navigation (its own comment admits there is no websocket bridge).
**Why tests miss it:** `useApprovals.test.ts:44-60` calls `__handleEventForTests`, exercising the handler directly rather than the transport.
**Fix:** either forward approval/activity events from `eventBus` to WS in `WebConnector`, or subscribe `watch_activity` in Thread/AppShell; refresh the badge on AppShell mount; unsubscribe the TopologyMap handler.

### [ ] H6. WebSocket lifecycle bugs (duplicate sockets, reconnect after logout)

**Where:** `packages/web/src/composables/useWebSocket.ts:20-26,71-104,108-120`
**What:**

- Module `connect()` always constructs a new `WebSocket`; exported `connect()` only guards `OPEN`, so a second call while `CONNECTING` leaks the first socket.
- `disconnect()` sets `stoppedByAuth = false` then calls `ws.close()`; the close handler schedules a reconnect, and the timer calls module `connect()` with no guard.
- The `error` handler closes the module-level `ws`, not the socket that errored, so a stale socket can close the new one.
- The close handler clears global `streamHandlers` for all sockets.

**Impact:** duplicate sockets and duplicate event delivery after reconnect/login; streams killed by a stale socket; reconnect attempts after logout.
**Fix:** guard against `CONNECTING`/`OPEN` and close the previous socket; track sockets per instance; suppress reconnect on intentional close; close `event.currentTarget` on error. Add tests for double connect and logout.

### [ ] H7. Approval card can disappear without resolving; live args are empty

**Where:** `packages/web/src/chat/ApprovalCard.vue:22-35`; `packages/core/src/tools/approval-response-tool.ts:88-91,181`; `packages/web/src/composables/useApprovals.ts:28`
**What:** `approval_response` returns `status: 'success'` with per-decision outcomes including `unauthorized`, `not_found`, and `conflict`. `ApprovalCard.decide()` treats any success as resolved and emits `resolved`; `Thread.vue:116-118` removes the card locally. Separately, live `approval:requested` events set `args: {}` because the event payload has no args (`AgentRuntime.ts:475-480`).
**Impact:** an unauthorized user clicks Approve, the card vanishes, but the approval remains pending server-side. Live cards cannot show what is being approved, which is a security-relevant omission.
**Fix:** inspect `data.results` and only remove on `approve`/`reject`/`acknowledged`; surface other outcomes. Fetch args via `list_pending_approvals` or include them in the event.

### [ ] H8. Cross-identity client state is not reset on logout

**Where:** `packages/web/src/App.vue:12-26`; module stores in `useApprovals.ts:13`, `useParticipants.ts:5`, `useConversations.ts:7-13`, `useReadState.ts:20`
**What:** logout resets only `useToolAccess`. Approvals, participants, conversations, active conversation, and read-state (localStorage `legion-last-read`) survive. `useApprovals` handlers are registered once and never removed.
**Impact:** after logout/login as another user (e.g. `limited-tester`), the previous user’s approvals, conversation list, participant list, and unread state remain visible until refreshed; stale badge counts; possible cross-identity data exposure.
**Fix:** add/reset methods for every module store and call them in `App.vue` on logout; scope read state per participant or clear it.

### [ ] H9. Editor saves bundle tools the caller may not have

**Where:** `packages/web/src/views/AgentEditor.vue:118-159`; `packages/web/src/views/UserEditor.vue:127-180`
**What:** `AgentEditor` always calls `set_participant_middleware` after `create_agent`/`modify_agent`. `UserEditor` always calls `set_approval_authority` (and `set_credential` when a password is supplied) after `create_user`/`modify_user`. The save button is gated only by the primary tool.
**Impact:** a user granted only `modify_agent`/`modify_user` gets a `hidden` error after the primary write already succeeded → partial state and a misleading failure; retrying can duplicate-create. Spec §6.1 describes separate affordances.
**Fix:** gate each secondary call with its own `toolAccess.can(...)`, skip if hidden, or expose them as separate buttons. Make create idempotent/transactional.

### [ ] H10. Operator flag can be self-granted; credentials are unscoped

**Where:** `packages/web/src/views/UserEditor.vue:224-227,152-157`; `packages/core/src/tools/user-tools.ts:13-51,53-95`; `packages/core/src/auth/AuthEngine.ts:9-18`; `packages/core/src/tools/management-tools.ts:772`; `packages/core/src/tools/secret-tools.ts`
**What:** `create_user`/`modify_user` accept `operator: true`; `AuthEngine` authorizes by tool name only, and `Collective` only guards _removing_ the last operator. `set_credential`/`set_secret` can target any participant.
**Impact:** a non-operator granted `modify_user`/`create_user` can promote themselves or create a new operator, then log in as it. Any holder of `set_credential` can reset any account’s password. This is privilege escalation.
**Fix:** require an operator privilege for granting `operator`; add server-side checks in `create_user`/`modify_user`; hide the checkbox unless the caller is an operator; scope `set_credential`/`set_secret` to self or require operator for others.

---

## Medium severity

### [ ] M1. Theme switching is unreachable and the light theme is broken

`useTheme.ts:25-29` `setTheme` is never called; no UI. Raw Tailwind colors (`text-slate-100`, `bg-cyan-700`, `text-amber-400`, `text-red-400`, `placeholder-slate-600`, etc.) in `ToolPolicyEditor`, `MiddlewareEditor`/`MiddlewareSchemaForm`, `SkillsSelector`, `SearchableCombobox`, `TypeBadge`, `StatusDot`, renderers, and `SlideOver` violate spec §3.4. `style.css:57-63,111-116,132-141` hardcodes white/black overlays, so tables/blockquotes are invisible on blueprint-light. Add a theme toggle in Account and replace raw colors with tokens.

### [ ] M2. Tool hints are dead

`Composer.vue:38-44` reads `auth.tools`; `useAuth.ts` never fetches `/api/auth/me` and exposes no `tools`. `useToolAccess` already has `callerPolicy` but isn’t used. Spec §4.4/open question 4.

### [ ] M3. AgentEditor middleware is half-wired

`AgentEditor.vue:268-273` passes `:skills="[]"` and `:credential-keys="[]"`, so skills/credential-reference fields are empty. `@validation` isn’t bound, so schema validation doesn’t block save.

### [ ] M4. `ApprovalAuthorityEditor` drops `participants`

`ApprovalAuthorityEditor.vue:21-27` emits only `{ tools }`; `AgentEditor.vue:87-89` normalizes to `{ tools }` on load; saving erases any `participants` authority.

### [ ] M5. Config error handling is inconsistent

`ConfigView.vue:53-56` deletes a provider without confirmation or error handling; `ProviderSlideOver.vue:35-55` and `RoutingEditor.vue:66-80` have no catch, so failed saves become unhandled rejections with no banner.

### [ ] M6. Process actions have no error handling

`ProcessDetail.vue:62-90` `onSend`/`onStop`/`onDelete` have `try/finally` but no catch; failures reject silently. `ProcessesView.vue:11` ignores `loading`/`error`, so a denied list looks like “No processes yet”.

### [ ] M7. `useToolStream` can hang on cancel and leaks on unmount

`useToolStream.ts:147-197` awaits `completion` with no timeout; if the terminal chunk never arrives, Stop hangs. `Thread.vue:141` and `useConversation.ts:129` use `cancelOnUnmount: false`, so dock sub-chats leave streams running after unmount.

### [ ] M8. MCP editor permits arbitrary command execution

`McpSourcesEditor.vue:86-107` sends arbitrary `command`/`args`; `runtime-tools.ts:206-253` validates only name/transport. Any user with `save_mcp_sources` auto can run arbitrary commands as the Legion user on next boot. Add confirmation/audit and restrict to operators.

### [ ] M9. Security hardening gaps

No login rate limiting (`auth.ts:22-46`); JWT in localStorage (`useAuth.ts:10`); no CSP/security headers (`WebConnector.ts`); no token revocation on password change (`AccountSlideOver.vue:36-54`); `set_credential`/`set_secret`/`create_user` unscoped (see H10). Recommend rate-limit, CSP, HttpOnly/short-lived tokens, token versioning, target scoping.

### [ ] M10. `list_pending_approvals` is unscoped

`runtime-tools.ts:168-189` returns every pending record; spec §4.5 says “visible to this user”. Filter by `authEngine.hasAuthority` or conversation membership.

### [ ] M11. `TypeBadge` uses the wrong key map

`TypeBadge.vue:3-9` keys are `message:sent`, `tool:call`, etc.; `ParticipantsList.vue:52` passes `p.type` (`agent`/`user`/...), so every participant badge falls back to neutral. Fix the map (agent/user/service/mock).

### [ ] M12. Mobile dock is not full-screen

`DockPanel.vue:38-41` combines `max-md:fixed max-md:inset-0` with inline `width: 420px`; width wins, so the overlay is 420px wide, not the full viewport (spec §3.2). Use `max-md:w-full` or conditional width.

### [ ] M13. Jump-to-message is dead

`CommunicatePanel.vue:29-36` emits `jump`; `DockPanel.vue:74-78` doesn’t bind or emit it; `ChatView.vue:170-172` `onDockJump` is a no-op. Spec §5.2 breadcrumb not implemented.

### [ ] M14. Login lands on `/participants`, not chat

`LoginView.vue:22`; spec §3.1 says Chat is home and the router redirects `/` → `/chat`. Pick one and update e2e.

### [x] M15. Stale e2e specs target the removed UI

`packages/e2e/tests/participants/participants.spec.ts` (table rows/slide-over), `config/providers.spec.ts` (“Provider instances available to agents”, default-model field), and `config/credentials.spec.ts` (`/config/credentials` route doesn’t exist). The Playwright config runs all `tests/`, so the full e2e gate will fail; these need deletion/rewrite.

### [x] M16. Dead code remains

`composables/useConversation.ts` (298 lines) and `useConversation.test.ts` (382 lines) are unused; legacy `components/conversations/ConversationList.vue`, `components/conversations/ApprovalCard.vue`, `components/common/ApprovalBadge.vue`, and `renderers/ToolResultRenderer.vue` are unused. Plan Task 21 cleanup is incomplete.

### [ ] M17. `useAuth` expiry is not reactive

`useAuth.ts:35-40` uses `Date.now()` with no timer; expiry won’t flip `isAuthenticated` until another reactive change. API 401 handles it, but the shell can show stale auth.

### [ ] M18. AgentEditor “Save authority” on a new agent is invalid

`AgentEditor.vue:278-288` shows it for `participantId === 'new'` and calls `set_approval_authority` with `'new'` → “Participant not found”. Hide it for new.

### [ ] M19. ChatView mobile drawer / reply target

`ChatView.vue:36-47` closes the drawer only when an id is selected, so “New conversation” leaves the drawer covering the draft. `ChatView.vue:131-138` always routes a reply to the first agent in a multi-agent conversation.

### [ ] M20. Thread approval matching is imprecise

`Thread.vue:76-83` matches pending approvals to messages by tool name only; multiple approvals for the same tool duplicate cards or attach to the wrong message. Use approvalId/toolCallId when available.

### [ ] M21. `useConversations` error handling and stream args

`useConversations.ts:44-58` uses `onChunk: () => void load()` with no catch (unhandled rejection if the tool is hidden); `getArgs` captures `filter.value.status` at start, so a status-filter change doesn’t restart the stream (no UI today).

### [ ] M22. `SearchableCombobox` stale value and raw colors

`SearchableCombobox.vue:17,46-48`: `selectedLabel` is not synced from `modelValue`; raw `slate`/`cyan` colors; no keyboard navigation.

### [ ] M23. `MiddlewareSchemaForm` array parsing

`MiddlewareSchemaForm.vue:106-110` splits arrays on commas; values containing commas are corrupted.

### [ ] M24. `ProcessStartForm` arg parsing

`ProcessStartForm.vue:29-32` splits on whitespace; args containing spaces cannot be expressed.

### [ ] M25. `FileSecretStore` read-modify-write is not locked

`FileSecretStore.ts:59-77`; concurrent `setSecret` calls can lose updates. Use `storage.withLock`.

### [ ] M26. Connector loader leaks started connectors on duplicates

`loader.ts:79-89` starts all connectors, dedupes by name; `LegionProcess.ts:580-591` skips registration on duplicate without calling `stop()`. A duplicate Telegram connector keeps polling.

### [ ] M27. Provider type inconsistencies

`runtime-tools.ts:55` `save_provider` enum omits `openai-responses` while `ProviderSlideOver.vue:84-89` offers it; `SystemProviderStore.ts:36-46` maps `anthropic` to `OpenAICompatibleProvider` (Anthropic’s Messages API is not OpenAI-compatible) and throws for `copilot`/`codex` while the UI offers them. Implement, disable, or label unsupported types.

### [ ] M28. `FileCredentialStore.set` stores raw plaintext

`FileCredentialStore.ts:49-53`; it is unused — remove it to avoid a footgun.

### [ ] M29. WebConnector minor issues

SPA fallback returns `index.html` for unknown `/api/*` (`WebConnector.ts:107-109`); a second `auth` frame while the first is pending can register twice (`219-245`); no WS heartbeat (Task 10 fixed the first two and deliberately omitted the heartbeat to avoid per-socket timer leaks in unit tests — follow-up).

### [ ] M30. `execute` cancelStream has no ownership check

`execute.ts:48,58` and `cancel-stream-tool.ts`: a participant can cancel another stream if they know the UUID. Low likelihood, but validate ownership.

---

## Low severity / nits

- [ ] L1. `AppShell` avatar dropdown doesn’t close on outside click/Escape.
- [ ] L2. Router has no catch-all; unknown routes render blank.
- [ ] L3. `Thread` streaming message sender is hardcoded `'assistant'`.
- [ ] L4. `ChatView.onStreamSend` uses `void` without catch; `onCreated` calls `void store.load()` without catch.
- [ ] L5. `Composer` clears the draft before the send is known to succeed; a failed send loses the text.
- [ ] L6. `useProcess` doesn’t surface `procStream.error`; live output can silently stop.
- [ ] L7. `useProcesses` polls every 5s regardless of visibility; `error` is ignored by the view.
- [ ] L8. `TopologyMap` `role="button"` on `<g>` has no keyboard handler.
- [ ] L9. `SlideOver` uses `text-slate-100`; light theme unreadable.
- [ ] L10. `AccountSlideOver` changes the password without asking for the current one; existing JWTs remain valid.
- [ ] L11. `LoginView` “bootstrap password printed to stdout” text may be stale.
- [ ] L12. `ParticipantsView`/`ChatView` show no denied/empty-state message when the list tool is hidden.
- [ ] L13. No live participant subscription (`watch_participants` unused); status changes require reload.
- [ ] L14. `useReadState` localStorage is shared across users.
- [ ] L15. Router guard doesn’t redirect authenticated users away from `/login`.
- [ ] L16. No cache headers for hashed assets; no request logging.
- [ ] L17. Bootstrap password printed to stdout (existing; logs).
- [ ] L18. `SystemProviderStore.save` uses `config.name` directly in a path; boundary checks prevent traversal, but names with `/` create nested files invisible to `list()`.
- [ ] L19. `save_provider` doesn’t validate `baseUrl` scheme (SSRF if a non-operator gets the tool).
- [ ] L20. `OpenAIResponsesProvider` has no retry/timeout; minor.
- [ ] L21. `useTheme()` applies the theme as a side effect on every call; harmless but surprising.

---

## Spec conformance summary

| Spec item                     | Status                                                                                                                |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| §3.1 shell/nav/avatar/account | Mostly done; theme switch missing; login landing mismatch                                                             |
| §3.2 desktop/mobile           | Desktop done; mobile dock not full-screen; drawer new-conv bug                                                        |
| §3.3 composables              | Mostly; `useConversation` dead; identity reset incomplete                                                             |
| §3.4 token layer              | Tokens defined; raw colors and no runtime switch                                                                      |
| §4.1 conversation list        | Done; unread client-only; no live participants                                                                        |
| §4.2 typed parts/registry     | Partly; process/file renderers missing for built-in tools                                                             |
| §4.3 forks                    | Done; index not synced; errors unhandled                                                                              |
| §4.4 composer                 | Send/stop done; tool hints dead; @mention basic                                                                       |
| §4.5 approvals                | Inline + badge exist; live updates not wired; args missing; outcome handling wrong                                    |
| §4.6 streaming                | Text/reasoning done; stop can hang; no typing indicator                                                               |
| §5.1 dock                     | Tabs/close/reorder done; persistence restore broken; mobile width                                                     |
| §5.2 registry                 | communicate + fallback done; jump breadcrumb dead; process/file panels missing                                        |
| §6.1 participants             | List/editors done; model picker broken; operator escalation; middleware skills/credentials empty; topology edges dead |
| §6.2 processes                | Carried over; error handling gaps                                                                                     |
| §6.3 config                   | Providers/routing/MCP done; routing hydration broken; provider errors                                                 |
| §7 backend tools              | Implemented; `list_pending_approvals` unscoped; `save_provider` enum mismatch                                         |
| §8 testing                    | Unit tests plentiful; stale e2e specs; key bugs untested                                                              |

## Test gaps

- No restore test for dock state (only write).
- No test for the real `list_models` shape (the test stubs the wrong shape).
- No hydration test for `RoutingEditor`.
- No test for `generate` re-run (`agentId`).
- No test for double WS connect / reconnect after logout.
- No transport-level approval test (`useApprovals.test` uses the internal handler).
- No identity-switch state-reset test.
- No test for approval `unauthorized` outcome.
- No test that `ApprovalAuthorityEditor` preserves `participants`.
- No test for middleware validation blocking save or skills/credentials hydration.
- Stale e2e specs for `participants`, `config/providers`, `config/credentials`.

## Strengths worth preserving

- Fail-closed tool gating: `useToolAccess.can()` returns `hidden` before the first fetch lands, and `refresh()` drops stale responses across logout.
- Markdown is sanitized (`html: false` + DOMPurify; `ansi_up` escapes HTML by default).
- Good unit-test volume (51 files, ~6k lines) and e2e coverage of the main journeys.
- Narrow connector runtime deps (no event bus) and a log-and-skip loader that never kills boot.
- Encrypted secret store: AES-256-GCM, random IV, scrypt-derived key, plaintext never returned by tools.
- The tool-call architecture is respected — no CRUD REST endpoints were added.
- Thoughtful inline comments explain decisions, even where they are now stale.

## Fix tracking

The implementation plan is at `docs/superpowers/plans/2026-11-04-web-ui-review-fixes.md`. Status is updated in this document as tasks land.
