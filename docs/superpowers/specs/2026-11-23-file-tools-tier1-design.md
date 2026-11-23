# Design: Legion file tools — Tier 1

**Date:** 2026-11-23
**Status:** Draft for review
**Base:** `main` at `c9199ef` (participant workspace roots merged)
**Scope:** Design only — no implementation in this change.

---

## Summary

Legion's built-in file tools are three small functions in
`packages/core/src/tools/file-tools.ts`: `file_read`, `file_write`, and `file_list`.
They work, but they are coarse:

- `file_read` returns the whole file as a plain string, with no paging, size cap, line
  numbers, or binary detection.
- There is no edit tool, so changing one line means rewriting the whole file.
- `file_list` returns bare names and loses the file/directory distinction.
- The model receives `JSON.stringify(ToolResult)`, so file text arrives escaped and
  expensive.

Tier 1 closes the highest-value gaps without importing OpenCode's heavier machinery:

1. Add a `file_edit` tool (exact-match, unique by default, optional `replaceAll`).
2. Add `offset`/`limit` paging, line numbers, and size caps to `file_read`.
3. Make `file_list` return typed entries, sorted directories first.
4. Return `created` from `file_write` and a human-readable summary.
5. Add an optional model-facing `content` field to `ToolResult`, used by the agent
   runtime instead of the JSON-serialized result.

Tier 2 (grep/glob) and Tier 3 (patch) remain out of scope.

---

## Decisions

| Decision            | Choice                                                                   |
| ------------------- | ------------------------------------------------------------------------ |
| Base branch         | `main`, after `feat/participant-workspace-roots` merged                  |
| Model-facing output | Optional `ToolResult.content`; structured `data` stays authoritative     |
| Edit matching       | Exact only in v1; no Unicode, trailing-whitespace, or CRLF normalization |
| Read paging         | 1-based `offset`, `limit` default and cap 2000 lines, 50 KB output cap   |
| Directory handling  | `file_read` stays file-only; `file_list` handles directories             |
| Tool names          | `file_read`, `file_write`, `file_edit`, `file_list`                      |

---

## 1. `ToolResult.content`

### Change

Add one optional field to `packages/types/src/tool.ts`:

```ts
export interface ToolResult {
  status: ToolResultStatus;
  data?: unknown;
  error?: string;
  /** Optional model-facing rendering of a successful result. */
  content?: string;
  approvalId?: string;
  message?: string;
}
```

### Semantics

- `data` remains the machine-readable payload used by middleware, approvals, and the web
  UI.
- `content`, when present, is the text the LLM should see for this tool result.
- `content` is a plain string. It is JSON-safe, so existing persistence and
  `cloneJsonSafe` paths are unaffected.

### Runtime use

`packages/core/src/runtime/AgentRuntime.ts`, in `buildProviderMessages`:

```ts
content: tr.result.content ?? JSON.stringify(tr.result),
```

`packages/core/src/tools/automation-tools.ts`, in `transcript`:

```ts
`tool_result id=${result.id} name=${result.name} result=${
  result.result.content ?? JSON.stringify(result.result)
}`;
```

No other call sites stringify tool results.

### Why this is small

- One optional type field.
- One conditional in the agent runtime.
- One conditional in the automation transcript.
- No change to `Tool`, `ToolRegistry`, approval persistence, or the web UI.

Errors do not need `content`; the runtime falls back to the JSON result, preserving the
current `status`/`error` shape.

---

## 2. `file_read`

### Input

```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "File to read, relative to the participant workspace root or absolute inside it"
    },
    "offset": {
      "type": "integer",
      "minimum": 1,
      "description": "The 1-based line to start reading from (default: 1)"
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 2000,
      "description": "Maximum number of lines to return (default and cap: 2000)"
    }
  },
  "required": ["path"]
}
```

### Constants

```ts
const MAX_READ_LINES = 2000;
const MAX_READ_BYTES = 50 * 1024;
const MAX_LINE_LENGTH = 2000;
```

### Behavior

1. Resolve `path` through the existing `resolveInWorkspace` helper.
2. Read the file as UTF-8.
3. If the text contains `\u0000`, fail with `Cannot read binary file: <path>`.
4. Split into physical lines:
   - `text.split('\n')`.
   - If the text ends with `\n`, drop the final empty element. A trailing newline
     terminates the last line; it does not add a line.
5. Validate `offset >= 1` and `limit >= 1`.
6. Select lines `offset - 1` through `offset - 1 + limit`.
7. Clamp each selected line to `MAX_LINE_LENGTH` characters, appending
   `... (line truncated to 2000 chars)` when clamped.
8. Stop adding lines when either the requested `limit` is reached or the next line would
   push the selected text over `MAX_READ_BYTES`.
9. If unselected lines remain, set `next` to the line number of the first unselected
   line.
10. Build structured data and model content.

### Output

```ts
{
  path: string;
  offset: number;        // first line number returned (the requested offset)
  lineCount: number;     // number of lines returned
  next?: number;         // line number to continue from when truncated
  content: string;       // selected lines, un-numbered, joined by '\n'
}
```

Model-facing `content`:

```text
Read file src/app.ts, lines 1-3
1: import { foo } from './foo.js';
2:
3: export const bar = foo();
```

When truncated:

```text
[Output truncated. Continue reading with offset: 2001]
```

When `offset` is past the end:

```text
Read file src/app.ts, 0 lines (offset 500 is past the end; the file has 42 lines)
```

When the file is empty:

```text
Read file src/app.ts, 0 lines
```

### Errors

| Case              | Message                                      |
| ----------------- | -------------------------------------------- |
| Missing file      | `File not found: <path>`                     |
| Directory         | `Path is a directory, use file_list: <path>` |
| Binary            | `Cannot read binary file: <path>`            |
| `offset < 1`      | `offset must be at least 1`                  |
| `limit < 1`       | `limit must be at least 1`                   |
| Outside workspace | `Invalid path (outside workspace): <path>`   |

### Notes

- `data.content` is the plain selected text. The `N: ` prefixes exist only in the
  model-facing `content` field, matching OpenCode's guidance.
- The whole file is read into memory, then sliced. Streaming/page-at-offset is a
  non-goal.
- Negative offsets (OpenCode's "tail" mode) are a non-goal.

---

## 3. `file_edit` (new)

### Input

```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "File to edit, relative to the participant workspace root or absolute inside it"
    },
    "oldString": {
      "type": "string",
      "description": "Exact text to find and replace"
    },
    "newString": {
      "type": "string",
      "description": "Replacement text; must differ from oldString"
    },
    "replaceAll": {
      "type": "boolean",
      "default": false,
      "description": "Replace every occurrence. When false, oldString must match exactly once."
    }
  },
  "required": ["path", "oldString", "newString"]
}
```

### Behavior

1. Resolve `path`; the file must exist and be a regular file.
2. Read the file as UTF-8. If it contains `\u0000`, fail with
   `Cannot edit binary file: <path>`.
3. Validate:
   - `oldString` must not be empty.
   - `oldString` and `newString` must differ.
4. Find occurrences with exact `indexOf` matching.
5. If there are zero matches, fail with:
   `Could not find oldString in <path>. It must match exactly, including whitespace and indentation.`
6. If there is more than one match and `replaceAll` is not `true`, fail with:
   `Found N matches for oldString, but expected exactly one. Add more surrounding context to make oldString unique, or set replaceAll to true.`
7. Replace either the single match or every non-overlapping match.
8. Write the result back as UTF-8.

### Output

```ts
{
  path: string;
  replacements: number;
}
```

Model-facing `content`:

```text
Edited src/app.ts (1 replacement)
```

or

```text
Edited src/app.ts (3 replacements)
```

### Errors

| Case              | Message                                                                      |
| ----------------- | ---------------------------------------------------------------------------- |
| Missing file      | `File not found: <path>`                                                     |
| Directory         | `Path is a directory: <path>`                                                |
| Binary            | `Cannot edit binary file: <path>`                                            |
| Empty `oldString` | `oldString must not be empty. Use file_write to create or overwrite a file.` |
| Identical strings | `No changes to apply: oldString and newString are identical.`                |
| No match          | See step 5 above                                                             |
| Multiple matches  | See step 6 above                                                             |
| Outside workspace | `Invalid path (outside workspace): <path>`                                   |

### Notes

- Exact matching means a file with CRLF line endings needs `\r\n` in `oldString`.
  CRLF-aware matching is deferred.
- `newString` may be empty, which deletes the matched text.
- No diff is returned in v1. The summary and replacement count are enough; diffs can be
  added later without changing the input schema.
- No lock or atomic write in v1. Concurrent edits can race; this is acceptable for the
  current single-process model.
- The tool description must tell the model to omit the `N: ` prefixes from
  `file_read` output.

---

## 4. `file_list`

### Input

Unchanged: `{ "path": string }`.

### Behavior

1. Resolve `path`.
2. Call `readdir(target, { withFileTypes: true })`.
3. Map each entry to:
   ```ts
   {
     name: string;
     type: 'file' | 'directory' | 'other';
   }
   ```
   `other` covers symlinks and anything that is neither a regular file nor a directory.
4. Sort directories first, then files, then other, alphabetically by name.
5. Build structured data and model content.

### Output

```ts
{
  path: string;
  entries: Array<{ name: string; type: 'file' | 'directory' | 'other' }>;
}
```

Model-facing `content`:

```text
Read directory src, 3 entries
components/
main.ts
types.ts
```

Directories carry a trailing `/`. Empty directory:

```text
Read directory src, 0 entries
```

### Errors

| Case              | Message                                    |
| ----------------- | ------------------------------------------ |
| Missing directory | `Directory not found: <path>`              |
| Path is a file    | `Path is not a directory: <path>`          |
| Outside workspace | `Invalid path (outside workspace): <path>` |

### Notes

- Hidden files remain included, matching current behavior.
- Recursive listing is a non-goal.
- Symlinks are reported as `other` rather than followed.

---

## 5. `file_write`

### Input

Unchanged: `{ "path": string, "content": string }`.

### Behavior

1. Resolve `path`.
2. Determine `created` by checking whether the target exists before writing.
3. Create missing parent directories.
4. Write the content as UTF-8, overwriting an existing file.

### Output

```ts
{
  path: string;
  created: boolean;
}
```

Model-facing `content`:

```text
Created file successfully: notes/a.txt
```

or

```text
Wrote file successfully: notes/a.txt
```

### Notes

- The tool description should say to prefer `file_edit` for partial changes.
- BOM preservation, formatting, and atomic writes are non-goals.

---

## 6. Shared helpers and constants

Keep the implementation in `packages/core/src/tools/file-tools.ts`; no new module is
needed for Tier 1.

Suggested helpers:

```ts
function splitPhysicalLines(text: string): string[];
function clampLine(line: string): string;
function readError(path: string, err: unknown): ToolResult;
function isBinary(text: string): boolean;
```

`resolveInWorkspace` stays as-is. It already accepts absolute paths inside the
participant's effective root and rejects `..` escapes.

---

## 7. Registration and permissions

- Add `fileEditTool` to the `fileTools` array:
  ```ts
  export const fileTools: Tool[] = [fileReadTool, fileWriteTool, fileEditTool, fileListTool];
  ```
- `fileTools` is registered globally in `packages/runtime/src/LegionProcess.ts`.
- `file_edit` is a normal tool subject to `ToolPolicy`; no new approval logic.
- Existing participants must add `file_edit` to their `tools` map to see it. This is a
  configuration change, not a code default. The default bootstrap operator is a user and
  does not need file tools.
- Argument scopes keep working: `path` resolves through `context.workspaceRoot`, so
  `pathPrefix` scopes follow the participant root.

---

## 8. Testing

### `packages/core/src/tools/file-tools.test.ts`

**`file_read`**

- Whole-file read returns the structured data and numbered model content.
- `offset`/`limit` returns the requested page and sets `next` when more lines remain.
- A trailing newline does not add an extra line.
- Empty file returns `lineCount: 0`.
- Offset past the end returns zero lines and the past-end note.
- Lines longer than 2000 characters are clamped.
- A file larger than 50 KB truncates on a line boundary and sets `next`.
- Binary file returns an error.
- Missing file, directory, invalid offset/limit, and outside-workspace paths return
  errors.
- Absolute paths inside the root still work (existing tests).

**`file_edit`**

- Single exact replacement.
- `replaceAll` replaces every occurrence.
- Zero matches returns the exact-match error.
- Multiple matches without `replaceAll` returns the count error.
- Multiple matches with `replaceAll` succeeds.
- Identical `oldString`/`newString` returns the no-change error.
- Empty `oldString` returns the empty-string error.
- Missing file and directory return errors.
- Replacement preserves indentation.
- CRLF file: `oldString` containing `\r\n` matches; a bare `\n` does not.

**`file_list`**

- Lists files and directories with types.
- Sorts directories first, then files.
- Empty directory returns zero entries.
- Missing path and file-instead-of-directory return errors.

**`file_write`**

- Returns `created: true` for a new file and `created: false` for an overwrite.
- Creates missing parent directories.
- Content round-trips through `file_read`.

### `packages/core/src/runtime/AgentRuntime.test.ts`

- Add a tool that returns `content` and assert the provider receives that string as the
  tool message content.
- Add or keep a tool without `content` and assert the provider receives
  `JSON.stringify(result)`.

### Verification

Before claiming done:

```bash
npm run format:check
npm run typecheck
npm test
```

---

## 9. Compatibility and rollout

- `ToolResult.content` is optional, so existing tools and persisted conversations are
  unaffected.
- `file_read` data changes from a string to an object. Only tests and any external
  consumers of the tool result need updating; the web UI does not special-case file
  tools.
- `file_list` data changes from `string[]` to typed entries. Same caveat.
- `file_write` data gains `created`; existing `path` consumers still work.
- `file_edit` is new, so no existing behavior changes.
- No schema migration is needed for conversations.

---

## 10. Risks

| Risk                                                               | Mitigation                                                                |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Whole-file read before slicing can use memory on very large files  | Output is capped; streaming is deferred                                   |
| Exact-only matching is unforgiving for CRLF or trailing whitespace | Clear error messages; normalization can be added without changing inputs  |
| No edit lock means concurrent edits can race                       | Legion is currently a single-process runtime; locking is deferred         |
| `content` duplicates text in persisted conversations               | Bounded by read caps; small for write/edit/list                           |
| New tool is invisible to existing participants                     | Document that `file_edit` must be added to each participant's `tools` map |

---

## Definition of done

- Four file tools are registered, with the schemas and outputs above.
- `ToolResult.content` is used by the agent runtime and automation transcript.
- Unit tests cover the cases in section 8.
- `format:check`, `typecheck`, and `npm test` pass.
