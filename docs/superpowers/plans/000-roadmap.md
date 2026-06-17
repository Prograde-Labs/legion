# Legion v2 — Implementation Roadmap

> Tracking document for the full plan set. Each plan is an independently testable
> subsystem built in dependency order. Source of truth for requirements is
> [`docs/legion-v2-greenfield-spec.md`](../../legion-v2-greenfield-spec.md).

## Goal

End state of the full plan set: a **functional web connector + Vue web interface**
(the MVP), backed by a complete multi-agent collective engine.

## Decisions locked in

- **Monorepo tooling:** npm workspaces, pure ESM (`"type": "module"`, `.js` import extensions).
- **Packages:** `@legion/types` (zero-dep, browser-safe shared models + wire DTOs + event
  payload map), `@legion/core` (engine; re-exports `@legion/types`), `@legion/runtime`
  (process entry + web connector), `@legion/web` (Vue SPA). The web frontend consumes
  `@legion/types` only, so Node-only deps never reach the browser bundle. Behavior/Node-coupled
  types (`Storage`, `EventBus` class, `Runtime`, `ToolContext`, `AuthEngine`) stay in core.
- **Language:** TypeScript strict (`noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`).
- **Test runner:** Vitest (globals), colocated `*.test.ts` / `*.integration.test.ts`.
- **Formatting:** Prettier — single quotes, semicolons, trailing commas, 100 cols, 2-space.
- **LLM providers:** custom `Provider` interface. Order: **OpenAI-compatible first**
  (covers OpenAI + local servers like Ollama/LM Studio), then Anthropic, then Copilot, then Codex.
- **First runnable deliverable (end of Plan 6):** end-to-end **mock** message loop +
  real `AgentRuntime` on an OpenAI-compatible provider behind an **env-gated** integration test.
- **MVP (end of Plan 11):** functional web connector + Vue SPA.

## Plan Sequence

| #   | Plan                                   | Spec §§           | Status           | File                                         |
| --- | -------------------------------------- | ----------------- | ---------------- | -------------------------------------------- |
| 1   | Foundation & core primitives           | 8, 10, 12, 15, 16 | Plan written     | `001-foundation-core-primitives.md`          |
| 2   | Conversations & message model          | 2, 10             | Plan written     | `002-conversations-message-model.md`         |
| 3   | Participants, Collective & credentials | 1, 6, 7           | Plan written     | `003-participants-collective-credentials.md` |
| 4   | Tools, ToolRegistry & AuthEngine       | 7, 14             | Plan written     | `004-tools-registry-authengine.md`           |
| 5   | Runtimes & MessageRouter (mock loop)   | 3, 4              | Plan written     | `005-runtimes-message-router.md`             |
| 6   | Provider abstraction & AgentRuntime    | 1, 4              | Plan implemented | `006-provider-agent-runtime.md`              |
| 7   | Approval bubbling                      | 7                 | Plan implemented | `007-approval-bubbling.md`                   |
| 8   | Service SDK & ServiceManager           | 5, 8              | Plan written     | `008-service-sdk-manager.md`                 |
| 9   | MCP tool sources                       | 9                 | Plan written     | `009-mcp-tool-sources.md`                    |
| 10  | LegionProcess, connectors & web server | 6, 8, 11, 12      | Plan written     | `010-process-connectors-web-server.md`       |
| 11  | Vue management SPA                     | 13                | Plan implemented | `011-web-management-spa.md`                  |

## Generation progress

- [x] Plan 1 written
- [x] Plan 2 written
- [x] Plan 3 written
- [x] Plan 4 written
- [x] Plan 5 written
- [x] Plan 6 implemented
- [x] Plan 7 written
- [x] Plan 8 written
- [x] Plan 9 written
- [x] Plan 10 written
- [x] Plan 11 written

**This session:** generating Plans 1–10 (foundation batch through LegionProcess + web server).

## Dependency notes

- Plan 7 (approval bubbling) is split from Plan 4 because emergent cross-connector
  bubbling can only be tested once the router + runtimes (Plan 5) exist.
- Plan 10 combines `LegionProcess` startup wiring with the web connector, since the
  connector depends on the assembled process.
