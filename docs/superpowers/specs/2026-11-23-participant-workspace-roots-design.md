# Participant Workspace Roots — Design

## Problem

Legion has one collective-wide workspace root. Every `ToolContext.workspaceRoot` is set
to the launch root (`LEGION_WORKSPACE` > first non-flag CLI arg > `cwd`), and both file
tools and process tools resolve relative paths against it. A participant cannot be
pointed at a different base directory, so agents working on separate projects all share
one working tree.

The goal: let each participant declare an optional `workspaceRoot` that becomes the base
for file tools and, by default, for process execution. This is a *default base
directory*, not a sandbox.

## Semantics

- Add `workspaceRoot?: string` to `BaseParticipant`. It applies to every participant
  type (agent, service, user, mock).
- Effective root resolution, in order:
  1. `participant.workspaceRoot` if set. Absolute values are used as-is; relative
     values resolve against the **launch root**.
  2. Otherwise `WorkspaceConfig.workspaceRoot` if set, resolved against the launch
     root.
  3. Otherwise the launch root.
- **Launch root** is the resolved `LEGION_WORKSPACE` / CLI arg / `cwd`. It is where
  `.legion/` lives and remains the storage anchor.
- `ToolContext.workspaceRoot` becomes the *effective* root, so tools and
  `ArgumentScope` follow it without per-tool changes to their containment logic.
- Add optional `ToolContext.collectiveWorkspaceRoot` carrying the launch root, so nested
  context construction can resolve relative participant roots and the config default.
  Existing contexts that omit it fall back to their own `workspaceRoot`.

`WorkspaceConfig.workspaceRoot` does **not** relocate `.legion/` storage. It only
supplies the default tool/process base. This avoids a chicken-and-egg between config
loading and storage init.

### Not a sandbox

Process tools can already run arbitrary commands and `cd` anywhere. A participant root
only changes defaults. File tools remain contained to the effective root.

## File tools

`file_read`, `file_write`, `file_list`:

- Relative paths resolve against the effective root.
- Absolute paths are accepted only when they resolve lexically inside the effective
  root; otherwise they fail with the existing "outside workspace" error.
- `..` escapes remain rejected.
- Keep the current lexical containment check (no symlink realpath) so behavior is
  otherwise unchanged.

## Process tools

`execute_command` and `start_process`:

- No `cwd` → effective root.
- Relative `cwd` → resolved against the effective root.
- Absolute `cwd` → used as-is.
- Resolution happens in `process-tools.ts` before calling `ProcessManager`, so
  `ProcessManager` keeps its current API and process logs stay under
  `<launchRoot>/.legion/processes`.

Update the `cwd` schema description to say it defaults to the participant workspace
root and that relative values resolve against it.

## Auth / argument scopes

`pathPrefix` scopes already resolve through `context.workspaceRoot`, so they follow the
effective root automatically. Every place that constructs a context or calls
`authorize` must stamp the effective root:

- `LegionProcess` top-level submit context.
- Connector `callTool` / `streamTool` contexts and their `authorize(...)` calls.
- `MessageRouter.buildRuntimeContext` — recompute for the **recipient**, not the
  sender. A message from a root-A agent to a root-B agent must give B root B.
- `ServiceContextImpl` — `callTool` auth and `buildToolContext`.
- `MiddlewareRunner` re-authorization and the middleware tool context built in
  `LegionProcess`.

The helper is the single source of truth; no caller resolves participant roots by hand.

## Editing and validation

- `create_agent`, `modify_agent`, `create_user`, `modify_user` gain a `workspaceRoot`
  parameter.
  - Omit on modify = keep the existing value.
  - `null` or `""` = clear (inherit the default).
- On write, resolve the value and validate that it exists and is a directory. A
  missing/non-directory root returns a tool error.
- Boot never fails when a stored root later disappears; tool and process calls surface
  errors naturally.
- Web: add a text input to `AgentEditor.vue` and `UserEditor.vue`, with help text that
  an empty value inherits the collective root.
- Services have no create/modify tool today; they are edited in the participant JSON.

## Non-goals

- Skill discovery and MCP server spawns stay collective/workspace-level.
- No data migration: an absent field means the launch root.
- No change to `.legion/` storage location.

## Testing

Unit / integration coverage:

- Helper resolution matrix: participant absolute, participant relative, config default,
  fallback, and precedence.
- File tools: absolute-inside-root succeeds; absolute-outside and `..` fail.
- Process tools: default, relative, and absolute `cwd` captured via a mock
  `ProcessManager`.
- Router: recipient context gets its own root; the sender's root does not leak.
- Auth: `pathPrefix` resolves against the effective root.
- Management/user tools: set, clear, reject missing/non-directory root.
- Web editor tests for load/save/clear.

Required gate before claiming done: `npm run format:check` → `npm run typecheck` →
`npm test` (plus `npm run test --workspace=packages/web` for the UI changes).

## Acceptance: live collective run

As a final check, run a real Legion collective (`npm run dev` or a built `npm start`)
with at least two agents configured with different `workspaceRoot` values, and verify:

1. Each agent's file tools read/write/list inside its own root, and absolute paths
   inside that root work.
2. An absolute path outside an agent's root is rejected.
3. `execute_command` with no `cwd` runs in the agent's root, and a relative `cwd`
   resolves under it.
4. `pathPrefix` approval scopes resolve against the agent's root.
5. A message between two agents does not leak one agent's root into the other's tool
   calls.

This live run is the last step after the automated suite passes.
