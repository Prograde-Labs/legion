# Tool Policy Simplification

**Date:** 2026-07-04
**Status:** Approved

## Problem

The current `ToolPolicy` model has three values (`'auto' | 'deny' | 'requires_approval'`) and a builtin default of `'requires_approval'`. This means any tool not explicitly listed in a participant's `tools` map is **visible to the LLM and gated at execution** — the agent sees it, calls it, and then gets a pending-approval request.

This is wrong. Tools not explicitly granted to a participant should not be visible to the LLM at all. The current model leaks every tool registered in the global `ToolRegistry` to every participant by default.

Secondary problems:

- `'deny'` as a policy value is redundant with absence — if the default were `'deny'`, not listing a tool and listing it as `'deny'` would be identical.
- `AuthEngine` has an engine-level `toolPolicies`/`defaultPolicy` layer that is never configured in production (`LegionProcess.ts` creates `new AuthEngine()` with no options). This is dead code that adds conceptual overhead.
- `create_agent`/`modify_agent` accept a `defaultPolicy` + `toolPolicies` and eagerly compose the full `tools` map via `composeTools`. Any tool registered **after** the agent was last saved is absent from the map and falls through to `requires_approval`. This is the direct cause of new tools (MCP, process tools) unexpectedly triggering approval requests.
- The UI `ToolPolicyEditor` shows a "Default policy" selector that is a misleading display-only inference (counts the most common existing policy), not a persisted field. It implies a semantic that doesn't exist.

## Goal

**A participant may only call tools explicitly listed in its `tools` map.** Absent = hidden. The `tools` map is an explicit allowlist, not a filter on a permissive default.

## Design

### 1. `ToolPolicy` type

```ts
// packages/types/src/tool.ts
export type ToolPolicy = 'auto' | 'requires_approval';
```

`'deny'` is removed. Its semantics are fully covered by absence from the `tools` map.

### 2. `AuthResult`

```ts
// packages/core/src/auth/AuthEngine.ts
export interface AuthResult {
  authorized: boolean;
  reason?: 'auto' | 'requires_approval' | 'hidden';
}
```

New `'hidden'` reason replaces `'deny'`. Callers can distinguish "tool not in your map" from "tool requires approval".

### 3. `AuthEngine` simplification

`AuthEngine` loses its constructor options entirely. The engine-level `toolPolicies` and `defaultPolicy` are removed (dead code — never configured in production). `resolvePolicy` collapses to a direct map lookup:

```ts
export class AuthEngine {
  authorize(
    _participantId: string,
    tool: string,
    _args: unknown,
    participantPolicies?: Record<string, ToolPolicy>,
  ): AuthResult {
    const policy = participantPolicies?.[tool];
    if (policy === 'auto') return { authorized: true, reason: 'auto' };
    if (policy === 'requires_approval') return { authorized: false, reason: 'requires_approval' };
    return { authorized: false, reason: 'hidden' };
  }

  hasAuthority(
    authority: ApprovalAuthority | undefined,
    requesterId: string,
    tool: string,
    _args: unknown,
  ): boolean {
    // unchanged
  }
}
```

`AuthEngineOptions` interface and `BUILTIN_DEFAULT` constant are removed.

### 4. `AgentRuntime` tool visibility

**Filter** (`AgentRuntime.ts`):

```ts
// before
.filter((tool) => (agent.tools[tool.name] ?? 'requires_approval') !== 'deny')
// after
.filter((tool) => agent.tools[tool.name] !== undefined)
```

Only tools present in the participant's `tools` map are shown to the LLM.

**Auth branch** — the `'deny'` execution branch is replaced with a defensive `'hidden'` handler. Since hidden tools are filtered before reaching the loop, this branch is unreachable in normal operation but guards against any direct `authorize()` call that bypasses the filter:

```ts
if (authResult.reason === 'hidden') {
  toolResults.push({
    id: tc.id,
    name: tc.name,
    result: { status: 'error', error: `Tool '${tc.name}' not available` },
  });
  continue;
}
```

The `'auto'` and `'requires_approval'` branches are unchanged. The approval flow (`pending_approval` → `approval_response` → resume) is unaffected.

### 5. Management tools

#### `create_agent` and `modify_agent`

`defaultPolicy` and `toolPolicies` parameters are removed from both tools. The `tools` argument is the full `Record<string, ToolPolicy>` map — what the caller provides is what gets stored, no composition.

`composeTools` and `normalizePolicy` helper functions are removed entirely.

`modify_agent` merge logic: if the caller omits `tools`, the existing map is kept unchanged. If `tools` is provided, it replaces the existing map entirely — including `tools: {}` (empty), which removes all tool access. This is intentional and consistent with the explicit-allowlist model.

`set_tool_policy` narrows its `policy` enum from `['auto', 'deny', 'requires_approval']` to `['auto', 'requires_approval']`.

#### New `remove_tool_policy` tool

Removes a tool entry from a participant's `tools` map (making it absent = hidden):

```ts
{
  name: 'remove_tool_policy',
  description: "Remove a tool from a participant's tools map, hiding it from the LLM.",
  parameters: {
    type: 'object',
    properties: {
      participantId: { type: 'string' },
      tool: { type: 'string' },
    },
    required: ['participantId', 'tool'],
  },
}
```

`remove_tool_policy` must be added to `MANAGEMENT_TOOLS` in `default-participants.ts` so the operator can call it without approval.

### 6. `ServiceContextImpl`

`callTool` error messages update:

```ts
// before
authResult.reason === 'requires_approval'
  ? 'requires_approval — no authority chain in service context (denied)'
  : (authResult.reason ?? 'denied')
// after
authResult.reason === 'requires_approval'
  ? 'requires_approval — no authority chain in service context (denied)'
  : authResult.reason === 'hidden'
    ? 'tool not available to this participant'
    : (authResult.reason ?? 'denied')
```

### 7. Frontend

#### `ToolPolicyEditor.vue`

Remove the "Default policy" selector (the three-button `allow` / `require-approval` / `deny` toggle at the top).

Show every tool from `availableTools` as a row:

- **Checkbox**: checked = tool is in the `tools` map, unchecked = absent (hidden from LLM).
- **Approval toggle** (visible only when checked): toggles between `auto` and `requires_approval`. Matches the existing `requireApproval` boolean pattern.

`ToolOverride` interface is unchanged:

```ts
export interface ToolOverride {
  tool: string;
  source: string;
  enabled: boolean;        // false = absent from map (hidden)
  requireApproval: boolean; // only meaningful when enabled = true
}
```

The "add tool override" select is removed — every registered tool is already listed as a row, unchecked by default.

#### `ParticipantSlideOver.vue`

- Remove `defaultPolicy` ref.
- Remove the policy-count inference logic that derived `defaultPolicy` from existing tool entries.
- On load: populate `overrides` directly from the participant's `tools` map. Every tool in `availableTools` gets a row; tools in the map show `enabled: true` with their policy; tools absent show `enabled: false`.
- On save: serialize `overrides` to a `tools` map:

```ts
tools: Object.fromEntries(
  overrides
    .filter(o => o.enabled)
    .map(o => [o.tool, o.requireApproval ? 'requires_approval' : 'auto'])
)
```

No `defaultPolicy` or `toolPolicies` sent to `create_agent`/`modify_agent`.

### 8. Default operator seeding

`packages/core/src/collective/default-participants.ts` is unchanged in structure. `MANAGEMENT_TOOLS` list gains `'remove_tool_policy'`. The `approval_response` entry added in the prior session fix stays. No `'deny'` values to remove — none existed.

### 9. Documentation updates

- **`docs/legion-v2-greenfield-spec.md`** §7: update `AuthEngine.authorize` return values; simplify policy resolution to "participant per-tool → hidden if absent".
- **`AGENTS.md`** line 14: update vocabulary `auto / deny / requires_approval` → `auto / requires_approval / hidden`.
- **`README.md`** lines 14, 112: same vocabulary update; simplify policy-resolution description.
- **`docs/superpowers/specs/2026-07-02-chat-interface-bugfixes-design.md`**: add note that `defaultPolicy` is superseded and removed by this design.

## Migration

No migration script required for the live workspace — existing participant configs in `.legion/collective/participants/*.json` contain only `'auto'` values. No `'deny'` entries exist in any live config. The behavior change for existing configs is:

- Tools absent from the `tools` map change from **visible+gated** to **hidden**. This is the intended fix.
- Existing `'auto'` entries are unaffected.

Tests using `defaultPolicy: 'auto'` on `AuthEngine` constructor rewrite to use explicit `tools` maps. Tests using `'deny'` policy rewrite to use an empty or partial `tools` map (absent = hidden).

## Affected files

| File | Change |
|------|--------|
| `packages/types/src/tool.ts` | Remove `'deny'` from `ToolPolicy` |
| `packages/core/src/auth/AuthEngine.ts` | Remove options, `BUILTIN_DEFAULT`, `resolvePolicy`; new inline logic |
| `packages/core/src/auth/AuthEngine.test.ts` | Remove deny/engine tests; update fail-safe test |
| `packages/core/src/runtime/AgentRuntime.ts` | Update filter; replace deny branch with hidden |
| `packages/core/src/runtime/AgentRuntime.test.ts` | Rewrite deny describe block |
| `packages/core/src/tools/management-tools.ts` | Remove `composeTools`, `normalizePolicy`, `defaultPolicy` params; update `set_tool_policy` enum; add `remove_tool_policy` |
| `packages/core/src/tools/management-tools.test.ts` | Update composeTools/defaultPolicy tests; add remove_tool_policy tests |
| `packages/core/src/tools/approval-response-tool.ts` | No change |
| `packages/core/src/service/ServiceContextImpl.ts` | Update error message branching |
| `packages/core/src/service/ServiceContextImpl.test.ts` | Rewrite `defaultPolicy: 'deny'` test |
| `packages/core/src/service/ServiceManager.test.ts` | Rewrite `defaultPolicy: 'auto'` usage |
| `packages/core/src/service/service.integration.test.ts` | Rewrite `defaultPolicy: 'auto'` usage |
| `packages/core/src/collective/default-participants.ts` | Add `remove_tool_policy` to MANAGEMENT_TOOLS |
| `packages/core/src/collective/default-participants.test.ts` | Assert `remove_tool_policy: 'auto'` |
| `packages/web/src/components/participants/ToolPolicyEditor.vue` | Remove default-policy selector; show all tools as rows |
| `packages/web/src/components/participants/ParticipantSlideOver.vue` | Remove `defaultPolicy` ref and inference; update load/save |
| `docs/legion-v2-greenfield-spec.md` | Update §7 AuthEngine description |
| `AGENTS.md` | Update vocabulary |
| `README.md` | Update vocabulary and policy-resolution description |
| `docs/superpowers/specs/2026-07-02-chat-interface-bugfixes-design.md` | Note `defaultPolicy` superseded |
