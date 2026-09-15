---
status: approved
base: 39ab15a
rigor:
  tests: test-after
  review: code
  review_at: end
  execution: inline
  rereview: always
  triggers_fired: []
---

# Dependency updates + npm vulnerability cleanup (2026-09)

GitLab issue: (to be created — will hold before/after audit evidence)
Worktree: /workspace/legion-deps (branch `chore/dependency-updates-2026-09` from main `39ab15a`)

## Intent

- **Problem (measured 2026-09-15):** `npm audit` reports **19 vulnerabilities
  (3 critical, 8 high, 8 moderate)**. 37 direct dependencies are outdated.
  Criticals: vitest ≤4.1.10 (+@vitest/mocker, vite-node), happy-dom ≤20.8.8,
  @vitest/coverage-v8 ≤3.2.5. Highs: @fastify/static ≤10.1.1, vite ≤6.4.2
  (+esbuild), nanoid, postcss, brace-expansion, fast-uri, find-my-way, ip-address.
  Moderates: fastify ≤5.12.0, dompurify ≤3.4.12, hono, qs, @hono/node-server.
- **Behavior change:** none intended — dependency versions + lockfile only.
  Test/build config updated **only** as required by major-version APIs.
  Runtime code touched only if @fastify/static 8→10 requires option changes.
- **Out of scope:** TypeScript 7 (native port — stay 5.9.3), vue-router 5,
  @vueuse/core 14, vite/plugin-vue beyond what gates require. Issues #3/#4.
  The stray uncommitted `package-lock.json` mod in /workspace/legion (main
  worktree local drift, 8 removed `"peer": true` lines) — will be resolved by
  this MR's committed lockfile.
- **Done when:**
  - `npm audit` reports 0 vulnerabilities (or a documented, justified remainder).
  - Gates green in this worktree: `format:check` → `typecheck` → `npm test`
    (core ≥ 1017 passed) → `npm run test --workspace=packages/web` (157 passed).
  - `npm run build` succeeds; production boot + live smoke: health 200, operator
    login, agent round-trip returns a real reply.
  - GitLab issue documents before/after; MR open targeting `main`.

## Open Questions (answered 2026-09-15 — Chris approved all three proposals)

- [x] **Breaking majors included?** The 3 criticals + vite/@fastify/static
      highs have NO non-breaking fix — clearing them requires vitest 2→5,
      vite 5→8, happy-dom 14→20, @fastify/static 8→10. **Approved:** yes,
      staged as separate commits with full gates after each stage.
- [x] **Fold in issue #5** (format:check fails on 2 committed sample files —
      missing trailing newlines)? Without it the format:check gate stays red on
      this branch regardless of deps. **Approved:** yes, 2-line fix, credited
      to #5 in the MR.
- [x] **@types/node 20 → 26** to match the running Node 26.5.1? Types-only.
      **Approved:** yes, in the safe stage.

## Unknowns

- [x] package.json map: root devDeps @types/node ^20.14.0, vitest ^2.0.0,
      @vitest/coverage-v8 ^2.1.9; web pkg happy-dom ^14.0.0 + plugin-vue 5.2.4;
      engines node >=20; no overrides/.npmrc/CI configs (recon deleg_91dee952).
- [x] vitest configs: root + web + runtime, all plain `defineConfig` inline
      `test:` blocks (globals, include/exclude, env node|happy-dom) — NO
      deprecated `workspace`/defineWorkspace field → vitest 5 config risk low.
- [x] vite config: packages/web/vite.config.ts (@tailwindcss/vite + vue, outDir
      dist). tsconfig web types: ["vite/client", "web-bluetooth"].
- [x] @fastify/static: imported in packages/runtime WebConnector.ts:6 (plugin
      registration options to verify during stage 2d).
- [x] CI: none tracked in repo.
- [x] Baseline gate numbers on pristine main — recorded in Task 1.

## Tasks

- [~] 1. Baseline gates on pristine main tree (verification only — record numbers)
  DONE 2026-09-15: npm ci clean (420 pkgs, 19 vulns); typecheck pass; core
  1018 passed / 16 skipped; web 157 passed; format:check RED on the two
  committed sample participants (issue #5) + this work file (pre-fix).
- [~] 2. Stage 1 — safe updates: `npm update` + `npm audit fix` (non-breaking
  transitives: nanoid, postcss, brace-expansion, fast-uri, find-my-way,
  ip-address, qs, hono, @hono/node-server, dompurify, fastify minor) +
  `@types/node` 26; then gates (format/typecheck/core/web)
  commits: [5708636]
  result: 19→8 vulns; typecheck pass; core 1019 (incl. new dispose test);
  web 157. @types/node 26 surfaced the asyncDispose gap → task 6a.
- [~] 3. Fix #5 — trailing newlines in the two committed sample participant
  files; format:check fully green (work file prettier-formatted too)
  files: .legion/collective/participants/compaction-agent.json, .legion/collective/participants/title-agent.json
  commits: [c0cfff7]
  note: prettier 3.9.6 (via npm update) also reflows 14 more files —
  included here (pure formatting; spot-checked semantics untouched).
- [~] 4. Stage 2a — vitest 5 + coverage-v8 5 + vite 8 + @vitejs/plugin-vue 6
  (atomic: vitest 5 peer-requires vite ≥6.4, so vitest+vite must resolve
  together; fresh lockfile resolution, user-approved 2026-09-15); gates
  commits: [13f0acc]
  result: all gates green (typecheck, core 1019, web 157, format, build,
  web build). Required code changes: loader import escape (35 test
  failures fixed), function-mock implementations in MCP tests, global→
  globalThis, web tsconfig +ESNext.Disposable lib +node types.
- [~] 5. (merged into task 4 — was standalone vite bump)
- [~] 6. Stage 2c — happy-dom 20 (web test env); web tests
  commits: [7cfed1b]
  result: web 157 green. Exposed a latent double-escape in
  renderPlainCodeBlock (real-browser bug masked by happy-dom 14's
  serializer); fixed by dropping escapeSanitizedText.
- [~] 6a. `@types/node` 26 follow-up: add `[Symbol.asyncDispose]` to the
  hand-rolled generator wrapper in `MessageRouter.sendStream` (aborts
  controller + closes inner), so the AsyncGenerator contract is complete
  files: packages/core/src/runtime/MessageRouter.ts, packages/core/src/runtime/MessageRouter.test.ts
  commits: [0abb061]
- [~] 7. Stage 2d — @fastify/static 10 (runtime static serving); typecheck + boot
  commits: [9df70b3]
  result: registration options compatible as-is; typecheck green.
- [~] 8. Full build + production boot + live smoke (health / login / round-trip)
  result: build + web build green; prod boot on :4110 with @fastify/static
  10 serving the vite-8 SPA (root 200 text/html, health ok); operator login
  ok; communicate round-trip via runtime loop returned success. sglang was
  down (workload not running) — used the repo e2e mock provider on :4501
  with user-level provider config; smoke stack torn down after.
- [ ] 9. GitLab issue (before/after audit table) + push branch + open MR to main

## Log

- 2026-09-15: recon (`npm outdated` / `npm audit --json`) done; subagent recon
  dispatched (deleg_91dee952); worktree /workspace/legion-deps created from
  main 39ab15a; baseline gates started.
- 2026-09-15: baseline recorded (task 1). Stage 1 committed (5708636) with
  honest pipefail gates; @types/node 26 exposed missing asyncDispose on
  sendStream wrapper → new task 6a, fixed + tested (0abb061).
- 2026-09-15: #5 fix folded into prettier 3.9.6 reflow commit (c0cfff7).
- 2026-09-15: vitest 5 install hit npm peer deadlock twice (coverage-v8/vitest
  mutual peers; then vitest 5 peer vite >=6.4 vs locked vite 5). npm's
  incremental resolve fails even with consistent manifests ("Found:
  vitest@2.1.9" from stale lock). Resolution: merged tasks 4+5 into one atomic
  stage and re-resolve from a clean lockfile — user-approved the node_modules +
  package-lock wipe 2026-09-15 (execute_code consent guard honored).
