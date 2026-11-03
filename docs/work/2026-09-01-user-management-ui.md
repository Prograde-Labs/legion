---
status: draft
rigor:
  tests: tdd
  review: spec+code
  review_at: per-task
  execution: subagent
  rereview: always
  triggers_fired: [auth, api-contract]
---

# User participant management + password UI

GitLab issue: https://gitlab.com/clwillingham/legion/-/work_items/7
Worktree: /workspace/legion-user-mgmt (branch `feat/user-management` from main `39ab15a`)

## Intent

- **Spec (source of truth):** `docs/superpowers/specs/2026-07-05-user-management-design.md`
  (approved 2026-07-05).
- **Reference plan:** `docs/superpowers/plans/2026-07-05-user-management.md`
  (task decomposition + test sketches; predates the middleware feature — adapt per
  the staleness notes below, do not copy verbatim).
- **Problem:** No UI path to create/edit user participants or set/change any
  participant's password. The agent slide-over is hardwired to `create_agent` /
  `modify_agent`, and `modify_agent` rejects non-agent participants
  (`management-tools.ts` — "Participant operator is not an agent"), so "Edit
  agent" on the bootstrap operator fails.
- **Behavior change:**
  - New core tools: `create_user`, `modify_user`, `set_approval_authority`
    (operator `auto` policy, registered like the other management tools).
  - `set_credential` rejects secrets < 8 chars.
  - Participants view: Type column; "+ New agent" AND "+ New user"; rows
    dispatch by type (user → `UserSlideOver`, agent → `AgentSlideOver`
    [renamed `ParticipantSlideOver`, **middleware tab preserved**], service/mock
    → no Edit).
  - `UserSlideOver`: name, password (blank = keep current), read-only identities,
    operator flag, tool policies, approval authority, retire (hidden for
    protected; disabled for self and last active operator).
  - `AgentSlideOver` gains an Approval authority tab (persisted via
    `set_approval_authority` since `modify_agent` has no such param).
  - `AccountView` at `/account` (sidebar entry): self-service password change
    (min 8, confirm-match, `set_credential` with own id).
- **Out of scope (spec §2):** operator passwordless login, approval-authority
  bulk management, connector-identity editing in UI (identities read-only),
  hard delete (retire only), first-login forced password change.
- **Done when:**
  - `npx vitest run packages/core/src/tools/management-tools.test.ts` green,
    including new `create_user` / `modify_user` / `set_approval_authority` /
    `set_credential` min-length cases.
  - Web suite green: new `ParticipantsView`, `UserSlideOver`,
    `ApprovalAuthorityEditor`, `AccountView` tests; renamed
    `AgentSlideOver` tests green including the existing middleware cases.
  - Gates: `npm run format:check` → `npm run typecheck` → `npm test` →
    `npm run test --workspace=packages/web` all pass in this worktree.
  - Live check on the 4100 server (from this worktree): operator creates user
    with password in UI → logout → login as that user → `/account` change
    password → logout → login with new password. Agent edit slide-over still
    shows Basic | Tool policies | Middleware | Approval authority and a
    middleware save still issues `set_participant_middleware`.

## Plan staleness (verified 2026-09-01 against main 39ab15a)

1. Plan Task 7's agent slide-over rewrite **drops the middleware tab** (props,
   `set_participant_middleware` on save, `middleware` in `create_agent`).
   `ParticipantSlideOver.vue` on main has 19 middleware references and
   `ParticipantSlideOver.test.ts` covers middleware. → Rename must preserve all
   of it; only ADD the approval tab.
2. Plan Task 9's `ParticipantsView.vue` uses `useEventStream` (does not exist —
   repo has `useToolStream` / `useWebSocket`) and drops `list_middleware` /
   `list_skills` loading that the agent slide-over now needs. → Keep current
   loading logic; add Type column + dispatch.
3. Plan Task 5's `managementTools` array is stale (missing
   `setParticipantMiddlewareTool`, `editMessageTool`, `pruneMessageTool`,
   `generateTool`, `switchBranchTool`, `modifyConversationTool`,
   `listModelsTool`). → Append the three new tools, don't replace.
4. Plan Task 1 assumes a `hunter2` fixture in the set_credential tests — verify
   it exists before editing (recon).
5. Check `packages/e2e` for any <8-char secrets before the guard lands
   (`legion-e2e-test` is fine; verify the rest — recon).
6. Re-verify `useAuth()` return shape, `AppSidebar.vue` nav array, and
   `router/index.ts` routes before tasks 8/10 (plan snippets may be stale —
   recon).

## Open Questions (for Chris — block approval)

- [ ] **Target branch:** implement on `feat/user-management` (off main
      `39ab15a`) and open an MR to `main`. OK?
- [ ] **Design gap in spec §5.3:** the user save path passes
      `approvalAuthority: authority ?? undefined` inline to `modify_user`,
      which makes "Clear authority" a no-op on the user path (undefined is
      omitted from the patch; null is not accepted as clear). The agent path
      instead always calls `set_approval_authority` (which supports null-clear).
      **Proposal:** make the user path symmetric — `modify_user`/`create_user`
      persist the inline authority when non-null, and the UI additionally calls
      `set_approval_authority` on the user path only when clearing. Approve
      this deviation from spec §5.3?
- [ ] **Operator checkbox:** spec says disable it when the target is the only
      active operator, but the plan's `UserSlideOver` only disables it when
      `protected`. Backend `Collective.update` throws on last-operator demotion
      anyway. **Proposal:** implement per spec (disable in both cases). Confirm?
- [ ] **Approval-authority tab for agents:** in scope per spec ("editing for
      both users and agents"). Keep, or drop to shrink the diff?

## Unknowns

- [x] `modify_agent` rejects non-agent participants → `management-tools.ts:827`
      ("Participant ${id} is not an agent").
- [x] `retire_agent` is type-agnostic (calls `collective.retire(id)`), usable
      for users → `management-tools.ts:239-256`.
- [x] `get_participant` returns the full stored config (incl.
      `approvalAuthority`, `identities`, `operator`, `protected`) →
      `management-tools.ts:281-303`.
- [x] `set_credential` exists, generic, already in operator `MANAGEMENT_TOOLS`
      (no min-length guard yet) → `management-tools.ts:769-792`,
      `default-participants.ts:24`.
- [x] Current `managementTools` array + `MANAGEMENT_TOOLS` list (see staleness
      note 3) → `management-tools.ts:1016-1036`, `default-participants.ts:5-34`.
- [x] `UserConfig` already in types; no schema change needed →
      `packages/types/src/participant.ts:48-57`.
- [x] `Collective.update` enforces last-operator invariant →
      `Collective.ts:184-190`.
- [x] `Collective.retire` throws for `protected: true` participants →
      `Collective.ts:213-231`.
- [x] `listActive()` excludes retired (`status ?? 'active' === 'active'`) →
      `Collective.ts:63-68`.
- [x] `update()` merges via `{ ...existing, ...patch }`; a patch key with value
      `undefined` KEEPS the key with `undefined` value; `JSON.stringify` (used by
      `FileStorage.writeJson`, `FileStorage.ts:101-102`) then omits it → clear-via-undefined
      persists as key-absent, but in-memory object still has the key until reload.
      Relevant to "clear authority" semantics (Open Question 2).
- [x] `hunter2` fixture exists: `management-tools.test.ts:894-903` (set_credential
      hash+verify test). No other <8-char secrets in that file.
- [x] `packages/e2e` secrets: `legion-e2e-test` (global-setup.ts:11), `super-secret` /
      `new-super-secret` (tests/config/credentials.spec.ts — these are provider credential
      VALUES, not participant passwords). No <8-char participant secrets → the
      `set_credential` guard breaks no e2e fixture.
- [x] `useAuth()` returns `{ isAuthenticated, participantId, login, logout,
      getToken }` → `useAuth.ts` return statement (participantId is a ref;
      `useAuth().participantId.value` is the id). Plan's test mock shape matches.
- [x] `AppSidebar.vue` nav array (lines 8-13) matches the plan's snippet exactly
      (Participants/Conversations/Events/Processes/Config). Route list:
      `/login`, `/` → `/participants`, `/participants`, `/conversations{,/new,/:id}`,
      `/processes{,/:id}`, `/events`, `/config` — all `meta: { requiresAuth: true }`
      except login; router guard at `router/index.ts:53`. Plan's `/account`
      addition is compatible as-is.

## Tasks

- [ ] 1. `set_credential` rejects secrets < 8 characters
      files: packages/core/src/tools/management-tools.ts, packages/core/src/tools/management-tools.test.ts
      note: the existing test at `management-tools.test.ts:894-904` uses `hunter2`
      (7 chars) and expects success — it MUST be updated to an ≥8-char secret (or
      split into a success + a rejection case) when the guard lands; the
      `verify('operator', 'hunter2')` assertion at :903 fails otherwise.
- [ ] 2. `create_user` tool (type user, active, identities auto-populated,
      name-uniqueness guard, protected:false, inline approvalAuthority)
      files: packages/core/src/tools/management-tools.ts, packages/core/src/tools/management-tools.test.ts
- [ ] 3. `modify_user` tool (type guard, partial patch, name collision guard,
      protected never settable)
      files: packages/core/src/tools/management-tools.ts, packages/core/src/tools/management-tools.test.ts
- [ ] 4. `set_approval_authority` tool (any type; null clears; malformed shape rejected)
      files: packages/core/src/tools/management-tools.ts, packages/core/src/tools/management-tools.test.ts
- [ ] 5. Register the three new tools (append to `managementTools`; add to
      `MANAGEMENT_TOOLS` in default-participants.ts; update that test if it
      asserts the list)
      files: packages/core/src/tools/management-tools.ts, packages/core/src/collective/default-participants.ts, packages/core/src/collective/default-participants.test.ts
- [ ] 6. `ApprovalAuthorityEditor.vue` shared component (wildcard toggle +
      clear; emits `update:authority`)
      files: packages/web/src/components/participants/ApprovalAuthorityEditor.vue, packages/web/src/components/participants/ApprovalAuthorityEditor.test.ts
- [ ] 7. Rename `ParticipantSlideOver.vue` → `AgentSlideOver.vue`, add
      Approval authority tab, PRESERVE middleware tab + props + save logic;
      persist authority via `set_approval_authority` (after modify_agent /
      after create_agent when non-null); update import in ParticipantsView.vue
      files: packages/web/src/components/participants/AgentSlideOver.vue (renamed), packages/web/src/components/participants/AgentSlideOver.test.ts (renamed + new cases), packages/web/src/views/ParticipantsView.vue (import only)
      rigor: review=spec+code
- [ ] 8. `UserSlideOver.vue` (name, password w/ keep-current semantics,
      read-only identities, operator flag [disabled when protected OR only
      active operator], tool policies, approval authority, retire button
      hidden-for-protected / disabled-for-self-and-last-operator; save per
      Open Questions answer re clear-authority)
      files: packages/web/src/components/participants/UserSlideOver.vue, packages/web/src/components/participants/UserSlideOver.test.ts
- [ ] 9. `ParticipantsView.vue`: Type column, "+ New user" button, type-dispatch
      to User/Agent slide-overs, no Edit for service/mock; keep current
      useToolStream/useWebSocket + middleware-data loading
      files: packages/web/src/views/ParticipantsView.vue, packages/web/src/views/ParticipantsView.test.ts
- [ ] 10. `AccountView.vue` + `/account` route + sidebar entry
      files: packages/web/src/views/AccountView.vue, packages/web/src/views/AccountView.test.ts, packages/web/src/router/index.ts, packages/web/src/components/layout/AppSidebar.vue
- [ ] 11. Live end-to-end check on the 4100 server from this worktree (build
      web, boot, user create→login→account password change→re-login; agent
      editor regression check incl. middleware tab)
      files: (verification only — no source changes expected)
      rigor: tests=none, review=skip

## Log

- 2026-09-01: work file created (draft). Spec + plan reviewed; 6 staleness items
  recorded. GitLab issue #7 filed. Worktree /workspace/legion-user-mgmt on
  feat/user-management @ main 39ab15a. Note: main worktree
  /workspace/legion has its own in-flight draft work file
  (2026-09-01-cancellation-cleanup-followup.md) — do not start user-management
  code there.
