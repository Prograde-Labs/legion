# User Management Design

**Date:** 2026-07-05
**Status:** Approved

## 1. Problem

The Participants view lists all participant types but editing any non-agent participant (e.g. the bootstrap operator, a user) opens `ParticipantSlideOver.vue` which calls `modify_agent`. That tool rejects with `Participant operator is not an agent`. There is no frontend path for creating users, editing user fields, setting passwords, or removing users.

## 2. Scope

- Create users via UI (name, tools, operator flag, approval authority, password)
- Edit existing users (same fields + identities read-only display)
- Set / reset user passwords (admin-set, and user self-change)
- Retire / remove users via UI
- Add approval authority editing to both users and agents
- Add a self-service Account screen for logged-in users to change their own password
- Auto-populate `identities` on user create for consistency with future connectors

Out of scope: local operator passwordless login, approval authority bulk management, connector identity editing in UI (identities shown read-only), hard delete (retire only).

## 3. Approach

Mirror the existing agent tool pattern. Add `create_user` and `modify_user` tools parallel to `create_agent` and `modify_agent`. Add a shared `set_approval_authority` tool usable on any participant type. Reuse `set_credential` (already generic) for password management. Reuse `retire_agent` (already calls `collective.retire`, type-agnostic) for retiring users. Frontend gets type-aware slide-overs: `AgentSlideOver.vue` (renamed from current) and new `UserSlideOver.vue`, plus an `ApprovalAuthorityEditor.vue` shared component used in both.

## 4. Backend

### 4.1 New Tools

**`create_user`**

```
params: { id, name, tools?, operator?, approvalAuthority?, identities? }
```

- Creates `UserConfig` with `type: 'user'`, `status: 'active'`, `protected: false`.
- `tools` defaults to `{}`.
- `operator` defaults to `false`.
- If `identities` omitted, auto-sets `[{ connector: 'web', externalId: id }]`.
- If `identities` provided, use as-is (allows pre-configuring Teams/Slack bindings).
- Rejects if `id` already exists (ConflictError from `Collective.add`).
- Rejects if `name` matches any existing active participant name (case-insensitive) — prevents login ambiguity.
- `protected` cannot be set via tool; always `false` on create.

**`modify_user`**

```
params: { id, name?, tools?, operator?, approvalAuthority?, identities? }
```

- Type-guards: rejects with `Participant ${id} is not a user` if target `type !== 'user'`.
- All fields optional; omitted fields keep existing values (merged via `Collective.update`).
- Name change: rejects if new name collides with another active participant (case-insensitive).
- Cannot set `protected: true` — stripped from patch if present.
- Last-operator guard: `Collective.update` already throws `InvariantError` if demoting the last operator; surfaces as tool error.

**`set_approval_authority`**

```
params: { participantId, authority: { tools: string | '*', participants: string | '*' } | null }
```

- Works on any participant type (users and agents).
- Setting `authority: null` clears approval authority (stores `undefined` so field is omitted from JSON, matching existing convention).
- Rejects malformed authority shapes (must have both `tools` and `participants` string fields, or be null).
- Participant must exist; error if not found.

### 4.2 Modified Tools

**`set_credential`** — add minimum password length validation:

- Reject secrets shorter than 8 characters with `Password must be at least 8 characters`.
- Applies to both admin-set and user self-change paths.
- Existing short-secret tests updated to use 8+ character values.

### 4.3 Tool Registration

All three new tools added to:

- `managementTools` array in `management-tools.ts`.
- `MANAGEMENT_TOOLS` list in `default-participants.ts` (operator gets `auto` policy for all three).

### 4.4 No Schema Changes

`UserConfig` in `packages/types/src/participant.ts` is unchanged — it already has `type: 'user'` and inherits `tools`, `approvalAuthority`, `status`, `identities`, `operator`, `protected` from `BaseParticipant`. No migration needed.

## 5. Frontend

### 5.1 ParticipantsView.vue

- Add **Type** column (between Status and Name) showing participant type as a small badge: cyan for `user`, slate for `agent`, muted for `service`/`mock`.
- Replace single "+ New agent" button with two buttons: **"+ New agent"** and **"+ New user"**.
- Row click dispatches to the correct slide-over based on `p.type`:
  - `agent` → `AgentSlideOver`
  - `user` → `UserSlideOver`
  - other types (service, mock) → no edit action (no button shown).
- Model column shows "—" for non-agent participants (already the case via `?? '—'`).

### 5.2 AgentSlideOver.vue (renamed from ParticipantSlideOver.vue)

- File rename: `ParticipantSlideOver.vue` → `AgentSlideOver.vue`. Component name and all imports updated.
- Title: "Edit agent" / "New agent" (unchanged).
- Retire button label: "Retire agent" (unchanged).
- New tab added: **Approval authority** — renders `ApprovalAuthorityEditor.vue`.
- Tabs: Basic | Tool policies | Approval authority.
- Save: `modify_agent` does not accept `approvalAuthority` as a param, so approval authority is persisted via a separate `set_approval_authority` call after the main save (only when authority has changed). On create: `create_agent` first, then `set_approval_authority` if non-null.

### 5.3 UserSlideOver.vue (new)

Tabs: **Basic** | **Tool policies** | **Approval authority**

**Basic tab fields:**

- **ID** — read-only after create (shown as monospace label).
- **Name** — editable text input. On create this also serves as the login name.
- **Password** — masked input with reveal toggle. Hint: "Leave blank to keep current password." On create, setting a password calls `set_credential` after `create_user`. On edit, if blank, skips `set_credential`.
- **Identities** — read-only table: connector | externalId. Shows auto-populated `web` identity. Label "Connector bindings (read-only — editing coming later)".
- **Operator** — checkbox toggle. Disabled when `participant.protected === true` or when target is the only active operator (computed from loaded list).
- **Status** — shows Active / Retired badge (read-only; retirement via Retire button).

**Tool policies tab:** reuses `ToolPolicyEditor.vue` unchanged.

**Approval authority tab:** reuses `ApprovalAuthorityEditor.vue`.

**Footer:**

- Left: "Retire user" button — hidden when `protected === true`; disabled when target is the only active operator or when `editingId === currentUserId`.
- Right: Cancel | Save.

**Save logic (edit):** call `modify_user` with all fields including `approvalAuthority` (native param — no separate `set_approval_authority` call needed for users), then conditionally `set_credential` (if password field non-empty).

**Save logic (create):** derive `id` from name (lowercase, spaces → hyphens, strip non-alphanumeric, fallback `user-{Date.now()}`). Call `create_user` with all fields including `approvalAuthority`, then conditionally `set_credential` (if password field non-empty).

**Retire:** calls `retire_agent` (tool is type-agnostic), same as agent path.

### 5.4 ApprovalAuthorityEditor.vue (new shared component)

- Two text inputs: **Tools pattern** (placeholder `*` for all, or specific tool name) and **Participants pattern** (placeholder `*` for all, or specific participant id).
- "Clear authority" button — sets both fields to empty, signals `null` to parent.
- Emits `update:authority` with `{ tools: string, participants: string } | null`.
- Helper text: "Use `*` to grant authority over all tools / all participants."
- Purely presentational — no API calls; parent handles persistence.

### 5.5 AccountView.vue (new)

- Route: `/account`.
- Sidebar entry: "Account" (icon: user circle), visible to all authenticated participants.
- Shows: participant name (read-only), participant type badge.
- Password change form: **New password** + **Confirm password** fields. Client-side validation: min 8 chars, must match. On save: calls `set_credential` with the logged-in user's own id from `useAuth`. Shows success/error inline.
- No other fields editable from Account (full profile editing is operator-only via Participants view).

## 6. Error Handling

| Scenario                     | Backend response                                     | UI treatment                                              |
| ---------------------------- | ---------------------------------------------------- | --------------------------------------------------------- |
| `modify_user` on agent id    | `Participant ${id} is not a user`                    | Never reached from UI (type-dispatched), tool defends     |
| `create_user` duplicate id   | ConflictError → tool error                           | Error banner in slide-over                                |
| `create_user` duplicate name | Tool error: `Name already in use`                    | Error banner                                              |
| `modify_user` name collision | Tool error: `Name already in use`                    | Error banner                                              |
| `set_credential` < 8 chars   | Tool error: `Password must be at least 8 characters` | Error banner; also client-validated                       |
| Retire protected participant | InvariantError → tool error                          | Retire button hidden                                      |
| Retire last operator         | InvariantError → tool error                          | Retire button disabled client-side + tool defends         |
| Self-retire                  | Allowed by backend                                   | Retire button disabled when `editingId === currentUserId` |
| Network / execute failure    | Error response                                       | Error banner above footer; form state preserved for retry |
| Account password mismatch    | Client only                                          | Inline validation error, Save disabled                    |

## 7. Login & Identity Consistency

**Current login flow (unchanged):** `POST /api/auth/login` with `{ name, password }`. Route finds participant by `name` (case-insensitive) in `collective.listActive()`, then calls `credentials.verify(participant.id, password)`. JWT signed with `participantId`.

**Identity change:** `create_user` auto-populates `identities: [{ connector: 'web', externalId: id }]`. This makes the data model consistent for future connectors (Teams, Slack) which will use `collective.findByIdentity(connector, externalId)` rather than name lookup. The web login route itself does not change in this iteration — it remains name-based. A future iteration will migrate web login to use `findByIdentity`.

**Name-as-login constraint:** duplicate name check in `create_user` and `modify_user` enforces that names are unique among active participants, preventing login ambiguity.

## 8. Testing

### Backend (`packages/core/src/tools/management-tools.test.ts`)

`create_user`:

- Adds participant with `type: 'user'`, `status: 'active'`.
- Auto-populates `identities` when omitted.
- Respects provided `identities`.
- Rejects duplicate id.
- Rejects duplicate name (case-insensitive).
- Sets `protected: false` always.

`modify_user`:

- Updates name, tools, operator, approvalAuthority, identities.
- Rejects when target is not a user.
- Rejects name collision with another participant.
- Cannot set `protected: true`.
- Triggers last-operator guard via `Collective.update`.

`set_approval_authority`:

- Sets authority on a user.
- Sets authority on an agent.
- Clears authority when passed `null`.
- Rejects malformed authority shape.
- Rejects non-existent participant.

`set_credential` (updated):

- Rejects secret shorter than 8 chars.
- Existing passing tests updated to use 8+ char secrets.

### Frontend (`packages/web/src`, happy-dom vitest)

`ParticipantsView.test.ts`:

- Renders Type column.
- "+ New user" button opens UserSlideOver.
- "+ New agent" button opens AgentSlideOver.
- Clicking user row opens UserSlideOver.
- Clicking agent row opens AgentSlideOver.
- Service/mock rows show no Edit button.

`UserSlideOver.test.ts`:

- Loads existing user via `get_participant` on open.
- Save (edit) calls `modify_user` (with `approvalAuthority` inline); conditionally calls `set_credential` (if password non-empty). No separate `set_approval_authority` call.
- Save (create) calls `create_user`.
- Retire calls `retire_agent`.
- Retire button hidden when `protected: true`.
- Retire button disabled when editing self.
- Password field blank by default; not sent if left blank on edit.
- Emits `saved` and `close` on success.

`ApprovalAuthorityEditor.test.ts`:

- Renders current authority values.
- Emits `update:authority` on change.
- Clear button emits `null`.

`AgentSlideOver.test.ts` (updated from ParticipantSlideOver.test.ts if it exists):

- Existing tests pass after rename.
- New: Approval authority tab renders ApprovalAuthorityEditor.
- New: save calls `set_approval_authority` when authority set.

`AccountView.test.ts`:

- Renders current user name.
- Save calls `set_credential` with own participantId.
- Client-side validation: rejects < 8 chars, rejects mismatch.
- Success message shown on save.

### E2E (stretch)

Full flow: login as operator → create user with password → logout → login as new user → Account → change password → logout → login with new password. Add only if setup cost is low.

## 9. Implementation Order

1. Backend: `create_user`, `modify_user`, `set_approval_authority` tools + unit tests.
2. Backend: `set_credential` min-length validation + update affected tests.
3. Backend: register new tools in `managementTools` array and `MANAGEMENT_TOOLS` in `default-participants.ts`.
4. Frontend: `ApprovalAuthorityEditor.vue` shared component + tests.
5. Frontend: rename `ParticipantSlideOver.vue` → `AgentSlideOver.vue`, add Approval authority tab, update imports.
6. Frontend: `UserSlideOver.vue` + tests.
7. Frontend: `ParticipantsView.vue` — Type column, two New buttons, type-dispatched slide-overs.
8. Frontend: `AccountView.vue` + `/account` route + sidebar entry + tests.
9. Format check → typecheck → unit tests → web tests.

## 10. Future Work (out of scope)

- Local operator passwordless login.
- Connector identity editing in UI (identities are read-only in this iteration).
- Web login migration from name-lookup to `findByIdentity`.
- Hard delete (permanent removal, not just retire).
- First-login forced password change flag.
- Connector-scoped user management (Teams/Slack identity binding UI).
