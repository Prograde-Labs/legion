# Argument Scope Control for Tool Policies — Design

**Date:** 2026-11-06
**Status:** Draft
**Roadmap item:** #6 (post-MVP wishlist, `012-post-mvp-roadmap.md`)
**Thread:** `2026-11-06-auth-scope` / branch `feat/auth-argument-scope`

---

## 1. Problem

`AuthEngine.authorize(participantId, tool, args, policies)` and
`AuthEngine.hasAuthority(authority, requesterId, tool, args)` already receive the call
arguments but ignore them. A participant either has a tool (`auto`) or needs approval
(`requires_approval`); there is no way to say "may write files, but only under `work/`" or
"may override the model, but only to models on this list".

Two consequences:

1. Tools with dangerous arguments are all-or-nothing. Granting `file_write` grants the
   whole filesystem; granting `communicate` grants any model override.
2. The `communicate` detail/model/deadline work (roadmap #2) explicitly left parameter
   authorization to this item. Per-call `model` is currently unauthenticated.

## 2. Goals

- Add an optional per-argument scope to a participant's per-tool policy.
- Keep the existing `'auto' | 'requires_approval'` strings working unchanged.
- Evaluate scope as part of authorization, at every place authorization already happens.
- Re-check scope when an approved tool resumes, so a policy change fails closed.
- Let any participant holding the management tools set scopes through them, and edit
  them in the web UI.
- Start with the constraints that cover the concrete cases: allowed values, regex, length,
  numeric bounds, and path containment.

## 3. Non-goals

- Contact/group visibility (roadmap #7). That affects both `communicate` and
  `list_participants`, so it belongs in those tools rather than the generic scope system.
- Scoping approval authority (`ApprovalAuthority`). Approvers remain unscoped.
- Nested argument paths (`a.b`, `items[].id`). Scope keys are top-level argument names.
- Multiple allowed roots per path rule. One `pathPrefix` per argument.
- Migrating stored participant configs. The widened type accepts both forms.
- Solving symlink TOCTOU races between check and execution.

## 4. Policy schema

All types live in `packages/types/src/tool.ts` and are exported from the package index.

```ts
export interface ArgScope {
  /** When true, the argument must be present (and non-null). Default: absent passes. */
  required?: boolean;
  /** Exact string match against one of the listed values. */
  enum?: string[];
  /** JavaScript regular expression source, validated when the policy is set. */
  pattern?: string;
  /** String length bounds. */
  minLength?: number;
  maxLength?: number;
  /** Numeric bounds. */
  min?: number;
  max?: number;
  /** Path containment: the argument must resolve inside this prefix. Relative prefixes
   *  resolve against workspaceRoot; absolute prefixes are used as-is. */
  pathPrefix?: string;
}

/** Scope keyed by top-level argument name. */
export type ToolScope = Record<string, ArgScope>;

export type ToolPolicy =
  'auto' | 'requires_approval' | { policy: 'auto' | 'requires_approval'; scope?: ToolScope };
```

A runtime helper in the same module normalizes the two forms:

```ts
export function normalizeToolPolicy(
  policy: ToolPolicy | undefined,
): { policy: 'auto' | 'requires_approval'; scope?: ToolScope } | undefined;
```

`undefined` means the tool is absent from the participant's map, i.e. hidden. The helper
lives in the types package because the web editor and core must agree on the shape and the
web depends only on `@legion-collective/types`.

## 5. Evaluation semantics

A new pure module, `packages/core/src/auth/ArgumentScope.ts`, evaluates a scope:

```ts
export interface ScopeContext {
  workspaceRoot: string;
}

export type ScopeResult = { ok: true } | { ok: false; arg: string; reason: string };

export function evaluateScope(
  tool: string,
  args: unknown,
  scope: ToolScope,
  ctx: ScopeContext,
): ScopeResult;
```

Rules:

- Arguments are read from the top level of `args`. If `args` is not a plain object, the
  call fails closed.
- An absent argument passes unless its rule sets `required: true`.
- `required: true` fails when the argument is missing, `undefined`, or `null`.
- All constraints on one argument are ANDed. The first failure is reported.
- String-only constraints (`enum`, `pattern`, `minLength`, `maxLength`, `pathPrefix`) and
  numeric constraints (`min`, `max`) cannot be combined on one argument: a value cannot be
  both a string and a finite number, so a mixed rule is rejected when the policy is set.
  When the tool declares an argument type, only matching constraints are accepted;
  unsupported argument types accept only `required`.
- Type mismatches fail closed: `enum`, `pattern`, `minLength`, `maxLength` require a
  string; `min` and `max` require a finite number.
- `enum` compares the string exactly.
- `pattern` uses `new RegExp(pattern).test(value)`. The pattern is validated when the
  policy is set; an invalid pattern that reaches evaluation fails closed.
- `pathPrefix` requires a string value:
  1. Reject any `..` path segment in `value` (split on both `/` and `\`) before resolving.
     Lexical resolution would otherwise collapse `..` before symlinks are resolved, so
     `link/../file` could pass the prefix check while the OS writes outside it.
  2. Resolve `prefix = path.resolve(ctx.workspaceRoot, rule.pathPrefix)` and
     `target = path.resolve(ctx.workspaceRoot, value)`. An absolute prefix resolves to
     itself; a relative one resolves under `workspaceRoot`.
  3. Resolve symlinks before comparing. If `target` exists, use
     `fs.realpathSync(target)`. If it does not, find the deepest existing ancestor,
     `realpath` it, and append the remaining segments. Apply the same treatment to the
     prefix when it exists.
  4. Pass when `resolvedTarget === resolvedPrefix` or
     `resolvedTarget.startsWith(resolvedPrefix + path.sep)`.
  5. Any filesystem or resolution error fails closed.
- Failure detail is human-readable and names the tool and argument, e.g.
  `file_write.path must be under work/`.

## 6. AuthEngine integration

`AuthResult` gains a scope reason:

```ts
export interface AuthResult {
  authorized: boolean;
  reason?: 'auto' | 'requires_approval' | 'hidden' | 'scope';
  /** Human-readable detail for reason 'scope'. */
  detail?: string;
}
```

`authorize()` gains an optional context argument:

```ts
authorize(
  participantId: string,
  tool: string,
  args: unknown,
  participantPolicies?: Record<string, ToolPolicy>,
  ctx?: { workspaceRoot: string },
): AuthResult;
```

Behaviour:

1. Resolve the policy with `normalizeToolPolicy`.
2. Absent policy → `hidden`.
3. Policy `requires_approval` and a scope is present: evaluate scope **first**. A
   violation returns `reason: 'scope'`; otherwise `requires_approval`.
4. Policy `auto` and a scope is present: evaluate scope. A violation returns
   `reason: 'scope'`; otherwise `auto`.
5. A configured scope with no `ctx` fails closed with `reason: 'scope'` and detail
   `argument scope unavailable: workspaceRoot missing`.

`hasAuthority()` is unchanged. Approver authority remains per-tool and per-requester.

## 7. Enforcement sites

`reason: 'scope'` must be handled explicitly at every site; today several sites fall
through to execution for any reason other than `hidden`/`requires_approval`.

| Site            | File                                                                    | Behaviour                                                                                       |
| --------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Agent tool loop | `packages/core/src/runtime/AgentRuntime.ts`                             | Push `{ status: 'error', error: detail }` for the tool call; do not execute                     |
| Approval resume | `packages/core/src/runtime/AgentRuntime.ts` (`processResumedApprovals`) | Re-run `authorize()` before executing; on violation, record the error result and do not execute |
| Service context | `packages/core/src/service/ServiceContextImpl.ts`                       | Return `{ status: 'error', error: detail }`                                                     |
| Process call    | `packages/runtime/src/LegionProcess.ts` (`callTool`)                    | Return `{ result: { status: 'error', error: detail }, conversationId: '' }`                     |
| Process stream  | `packages/runtime/src/LegionProcess.ts` (`streamTool`)                  | Yield `{ type: 'stream:error', error: detail }`                                                 |
| Middleware      | `packages/core/src/middleware/MiddlewareRunner.ts`                      | `toolFailure(..., 'rejected', ...)` with the scope detail                                       |

`workspaceRoot` is available as `context.workspaceRoot` at the core and runtime sites.
`MiddlewareRunnerDependencies` gains a required `workspaceRoot: string`, supplied where
the runner is constructed. `AgentRuntime.processResumedApprovals` uses
`context.workspaceRoot`.

Scope is checked before the approval branch, so an out-of-scope call is denied even when
the tool requires approval. On resume the same `authorize()` runs again, so a policy
change between approval and execution fails closed.

## 8. Management tools and validation

`set_tool_policy` gains an optional `scope`:

```ts
{
  participantId: string;
  tool: string;
  policy: 'auto' | 'requires_approval';
  scope?: ToolScope; // replaces the tool's scope; {} clears it; omitted leaves it unchanged
}
```

`create_agent`, `modify_agent`, `create_user`, and `modify_user` accept both policy forms
in their `tools` maps. Their schema descriptions change from "(auto or requires_approval)"
to describe the optional scope object.

These management tools are authorized by the caller's own tool policy, not by an operator
flag: any participant holding `set_tool_policy`, `remove_tool_policy`, `create_agent`,
`modify_agent`, `create_user`, or `modify_user` may manage any participant's policies and
scopes.

A shared validator in core, e.g. `packages/core/src/auth/validateToolPolicy.ts`:

```ts
validateToolPolicy(tool: Tool | undefined, value: unknown):
  | { ok: true; policy: ToolPolicy }
  | { ok: false; error: string };
```

Checks:

- The value is a valid string policy or an object with a valid `policy`.
- `scope` is a plain object whose keys are non-empty strings.
- `enum` is a non-empty array of strings.
- `pattern` compiles with `new RegExp`.
- `minLength`/`maxLength`/`min`/`max` are finite numbers, with `min <= max` and
  `minLength <= maxLength` when both are present.
- String-only and numeric constraints are not combined on one argument; when the tool
  declares the argument's type, only matching constraint kinds are accepted and
  unsupported types accept only `required`.
- `pathPrefix` is a non-empty string.
- When `tool.parameters.properties` exists, every scope key must name a declared
  argument; unknown names are rejected.
- Unknown constraint fields are rejected.

Validation runs when the policy is set and when a participant is created or modified.
Loaded configs are not re-validated at boot; a malformed scope fails closed at call time.

`list_tools` returns normalized policies so the editor does not need to understand the
union:

```ts
{
  tools: string[];
  callerPolicy: Record<string, { policy: 'auto' | 'requires_approval'; scope?: ToolScope }>;
  parameters: Record<string, JSONSchema>; // each registered tool's argument schema
}
```

`useToolAccess` accepts both `string` and object entries, so existing gating code keeps
working. The auth route continues to expose tool names only.

## 9. Web editor

- `ToolOverride` gains `scope?: ToolScope`.
- `AgentEditor` and `UserEditor` normalize stored policies on load and emit the string
  form when no scope is present, the object form when one is.
- `ToolPolicyEditor` gets an expandable per-tool scope section:
  - argument name picker populated from `list_tools.parameters` (free text allowed);
  - constraint fields for the supported kinds;
  - add/remove argument rows and a clear-scope action;
  - editable for every caller that can invoke the owning management tool.
- Client-side validation mirrors the server rules for immediate feedback; the server
  remains authoritative.

## 10. Testing

**`ArgumentScope` unit**

- Each constraint passes and fails as specified.
- Multiple constraints AND together.
- Absent argument passes; `required: true` fails.
- Type mismatches fail closed.
- Path containment: relative inside passes; `..` escape fails; absolute outside fails;
  `work` does not match `workspace`; symlink escape fails; non-existent target under an
  allowed parent passes; non-existent target outside fails.
- Invalid regex and non-finite bounds fail closed.

**`AuthEngine` unit**

- String and object forms resolve identically.
- Scope violation returns `reason: 'scope'` with detail.
- Scope with missing `ctx` fails closed.
- `requires_approval` + scope violation returns `scope`, not `requires_approval`.
- `hasAuthority` behaviour unchanged.

**Core/runtime**

- `AgentRuntime`: violation yields an error tool result and the tool is not executed;
  approval request passes scope; resume re-checks and fails closed on a changed policy.
- `ServiceContextImpl.callTool`, `LegionProcess.callTool`, `LegionProcess.streamTool`,
  and `MiddlewareRunner` produce the structured error in each shape.
- Management tools: set/replace/clear scope; validation rejects unknown arguments, bad
  regex, inconsistent bounds, and unknown fields; `create_agent`/`modify_agent`/
  `create_user`/`modify_user` accept the object form; `list_tools` returns normalized
  policies and parameters.

**Web**

- Editor emits the object form only when a scope exists; loads both stored forms;
  editable for every caller that can invoke the owning management tool.
- `useToolAccess` gating works with object policies.

**Gate**

`npm run format:check` → `npm run typecheck` → `npm test`, plus the web package tests.

## 11. Risks

- **Symlink TOCTOU:** containment is checked before execution; a symlink swapped between
  check and use is a residual race. Accepted.
- **Regex cost:** operator-supplied patterns can be expensive. They are validated at set
  time and applied to short string arguments. Accepted.
- **Approval semantics change:** a scope violation on a `requires_approval` tool now
  denies without asking an approver. This is intentional: scope is a hard boundary.
- **No migration:** legacy malformed scopes fail closed at call time rather than blocking
  startup.
- **Type widening:** consumers that compare policies to string literals must use
  `normalizeToolPolicy`; the compiler finds them.

## 12. Rollout

1. Types: `ArgScope`, `ToolScope`, widened `ToolPolicy`, `normalizeToolPolicy`; tests.
2. `ArgumentScope` evaluator; tests.
3. `AuthEngine` delegation, `AuthResult` scope reason; tests.
4. Wire `workspaceRoot` into all six enforcement sites, including the approval-resume
   re-check; tests per site.
5. Management tools (`set_tool_policy`, `create_agent`, `modify_agent`, `create_user`,
   `modify_user`, `list_tools`) and `validateToolPolicy`; tests.
6. Web editor, `useToolAccess`, load/save normalization; tests.
7. Docs: mark roadmap #6 landed, update `docs/legion-v2-greenfield-spec.md` §7 with the
   scope predicate, and record the deferred items.

## 13. Deferred

- Scoped approval authority (approvers may only approve within their own allowed region).
- Nested argument paths.
- Multiple allowed roots per path rule.
- Contact/group visibility (roadmap #7).
- Re-validating stored configs at boot.
