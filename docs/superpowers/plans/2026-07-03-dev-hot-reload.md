# Dev Hot-Reload Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `npm run dev` command that runs the full Legion stack (backend + frontend) with zero pre-build, instant Vue HMR, and ~1-2s backend restart on any TypeScript file change.

**Architecture:** `tsx --watch` runs the TypeScript source directly (no compile step) using path aliases in `tsconfig.dev.json` to redirect `@legion/core` and `@legion/types` imports from `dist/` to `src/`. In dev mode, `WebConnector` replaces `@fastify/static` with an embedded Vite dev server middleware, keeping everything on one port.

**Tech Stack:** `tsx` (TypeScript execution via esbuild), `vite` (already in `packages/web/devDependencies`), Fastify middleware mode

**Spec:** `docs/superpowers/specs/2026-07-03-dev-hot-reload-design.md`

---

## File Map

| File | Action | What changes |
|---|---|---|
| `tsconfig.dev.json` | **Create** | Root-level tsconfig with `paths` aliases pointing workspace packages to their `src/` |
| `packages/runtime/bin/legion.js` | **Modify** | Parse `--dev` flag; pass `{ dev }` to `LegionProcess.start()` |
| `packages/runtime/src/LegionProcess.ts` | **Modify** | Accept `options?: { dev?: boolean }`; derive `webSrcPath` in dev; pass `dev` + `webSrcPath` to `WebConnector` |
| `packages/runtime/src/server/WebConnector.ts` | **Modify** | Add `dev?: boolean` + `webSrcPath?: string` to deps; swap static plugin for Vite middleware when `dev: true`; close Vite on `stop()` |
| `package.json` (root) | **Modify** | Add `dev` script; add `tsx` devDependency |

---

## Task 1: Add `tsconfig.dev.json`

**Files:**
- Create: `tsconfig.dev.json`

This file tells `tsx` to resolve `@legion/core` and `@legion/types` from their TypeScript source rather than their compiled `dist/` directories. Without this, `tsx` would try to import `packages/core/dist/index.js` which may not exist.

- [ ] **Step 1: Create `tsconfig.dev.json` at repo root**

```json
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@legion/types": ["packages/types/src/index.ts"],
      "@legion/core": ["packages/core/src/index.ts"]
    }
  }
}
```

- [ ] **Step 2: Verify tsx can resolve imports with the new config**

```bash
npx tsx --tsconfig tsconfig.dev.json -e "import('@legion/core').then(m => console.log('ok:', typeof m.EventBus))"
```

Expected output: `ok: function`

If it prints `ok: function`, the path aliases are working. If you get a module-not-found error, check that `packages/core/src/index.ts` exports `EventBus`.

- [ ] **Step 3: Commit**

```bash
git add tsconfig.dev.json
git commit -m "feat(dev): add tsconfig.dev.json with workspace path aliases for tsx"
```

---

## Task 2: Add `tsx` devDependency and `dev` script to root `package.json`

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install `tsx` as a root devDependency**

```bash
npm install --save-dev tsx
```

- [ ] **Step 2: Add the `dev` script to `package.json`**

Open `package.json`. In the `"scripts"` section, add after the existing `"start"` line:

```json
"dev": "tsx --watch --tsconfig tsconfig.dev.json packages/runtime/bin/legion.js --dev",
```

The full scripts section should look like:

```json
"scripts": {
  "build": "tsc --build",
  "clean": "tsc --build --clean",
  "test": "vitest run",
  "test:integration": "LEGION_INTEGRATION=1 LEGION_MCP_INTEGRATION=1 vitest run",
  "test:coverage": "vitest run --coverage",
  "test:coverage:integration": "LEGION_INTEGRATION=1 LEGION_MCP_INTEGRATION=1 vitest run --coverage",
  "test:watch": "vitest",
  "format": "prettier --write .",
  "format:check": "prettier --check .",
  "typecheck": "tsc --build --force",
  "start": "node packages/runtime/bin/legion.js",
  "dev": "tsx --watch --tsconfig tsconfig.dev.json packages/runtime/bin/legion.js --dev",
  "test:e2e": "playwright test --config packages/e2e/playwright.config.ts"
},
```

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat(dev): add tsx dependency and npm run dev script"
```

---

## Task 3: Extend `bin/legion.js` to parse `--dev` flag

**Files:**
- Modify: `packages/runtime/bin/legion.js`

The current `bin/legion.js` imports from `../dist/LegionProcess.js`. In dev mode (run via `tsx`), we want it to import from the TypeScript source instead. `tsx` will handle the `.ts` → `.js` extension remapping at runtime.

- [ ] **Step 1: Update `bin/legion.js`**

Replace the entire file with:

```js
#!/usr/bin/env node
import { LegionProcess } from '../src/LegionProcess.js';

const dev = process.argv.includes('--dev');

// workspaceRoot: env var > first non-flag arg > cwd
const workspaceRoot =
  process.env.LEGION_WORKSPACE ??
  process.argv.slice(2).find((a) => !a.startsWith('-')) ??
  process.cwd();

console.log(`Starting Legion runtime in: ${workspaceRoot}${dev ? ' [dev]' : ''}`);

const lp = await LegionProcess.start(workspaceRoot, { dev });

async function shutdown() {
  console.log('\nShutting down...');
  await lp.stop();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
```

**Important:** The import path changes from `'../dist/LegionProcess.js'` to `'../src/LegionProcess.js'`. When this file is run in production via `node packages/runtime/bin/legion.js`, Node will resolve `../src/LegionProcess.js` — but production users should still run the compiled output. To preserve production behaviour, update the `start` script in the root `package.json` to point to the compiled dist:

In `package.json`, change:
```json
"start": "node packages/runtime/bin/legion.js",
```
to:
```json
"start": "node packages/runtime/dist/LegionProcess.js",
```

Wait — actually `LegionProcess` is a class not a script entry. Keep `start` as-is but update `bin/legion.js` to detect whether it's being run by `tsx` (in which case `src/` import works) or plain `node` (in which case `dist/` is needed). The cleanest approach: use a try/catch to attempt `src/` first, falling back to `dist/`. But that's over-engineered.

**Simpler solution:** `bin/legion.js` always imports from `../src/LegionProcess.js`. When run in production (after `npm run build`), the `dist/` doesn't matter — the `src/` files exist and Node can run them as plain ESM... except they import `@legion/core` which resolves to `dist/`. So production still needs the build.

**Actually the correct split:** keep two entrypoints conceptually but in one file using a dynamic import:

```js
#!/usr/bin/env node
const dev = process.argv.includes('--dev');

// In dev mode tsx resolves .js → .ts, so src/ import works.
// In production, built dist/ files are used directly — but the bin
// file still imports from src/ because tsx isn't running; use dist import.
const { LegionProcess } = dev
  ? await import('../src/LegionProcess.js')
  : await import('../dist/LegionProcess.js');

const workspaceRoot =
  process.env.LEGION_WORKSPACE ??
  process.argv.slice(2).find((a) => !a.startsWith('-')) ??
  process.cwd();

console.log(`Starting Legion runtime in: ${workspaceRoot}${dev ? ' [dev]' : ''}`);

const lp = await LegionProcess.start(workspaceRoot, { dev });

async function shutdown() {
  console.log('\nShutting down...');
  await lp.stop();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
```

This means:
- `npm run dev` → `tsx --watch` → `--dev` flag set → imports `../src/LegionProcess.js` → tsx resolves all `.ts` transitively
- `npm start` → `node` → no `--dev` → imports `../dist/LegionProcess.js` → compiled output as before

Use the version above (with the conditional dynamic import).

- [ ] **Step 2: Verify production path still resolves (requires a prior build)**

```bash
npm run build && node packages/runtime/bin/legion.js --help 2>&1 || true
```

Expected: process starts (or exits with a workspace error), not a module-not-found error.

- [ ] **Step 3: Commit**

```bash
git add packages/runtime/bin/legion.js
git commit -m "feat(dev): extend bin/legion.js with --dev flag and conditional src/dist import"
```

---

## Task 4: Extend `LegionProcess.start()` to accept `{ dev }` option

**Files:**
- Modify: `packages/runtime/src/LegionProcess.ts`

- [ ] **Step 1: Add `StartOptions` type and update the `start` signature**

At the top of `LegionProcess.ts`, below the existing imports, add the options type. Then update the `start` method signature on line 58:

Change:
```ts
static async start(workspaceRoot: string): Promise<LegionProcess> {
```

To:
```ts
export interface StartOptions {
  dev?: boolean;
}

// inside the class:
static async start(workspaceRoot: string, options: StartOptions = {}): Promise<LegionProcess> {
```

Place the `StartOptions` interface just before the class declaration (line 42), not inside it.

- [ ] **Step 2: Derive `webSrcPath` and pass `dev` + `webSrcPath` to `WebConnector`**

Find the Step 9 block (around line 160–179). Replace it with:

```ts
// ── Step 9: Initialise web connector ─────────────────────────────────────
const port = process.env.PORT
  ? parseInt(process.env.PORT, 10)
  : (workspaceConfig.server?.port ?? 3000);
if (isNaN(port)) {
  throw new Error(`Invalid PORT env var: "${process.env.PORT}" — must be a number`);
}
const webConnectorConfig = { ...(workspaceConfig.server ?? {}), port };
const _dirname = fileURLToPath(new URL('.', import.meta.url));

const dev = options.dev ?? false;
// In dev mode, point Vite at the web package source root (contains index.html + src/).
// In production, serve the pre-built static files from web/dist/.
const webSrcPath = dev
  ? join(_dirname, '..', '..', '..', 'web')          // packages/runtime/src/ → packages/web/
  : undefined;
const webDistPath = dev
  ? undefined
  : join(_dirname, '..', '..', 'web', 'dist');        // packages/runtime/dist/ → packages/web/dist/

const webConnector = new WebConnector({
  collective,
  credentials,
  eventBus,
  serverConfig: webConnectorConfig,
  webDistPath,
  webSrcPath,
  dev,
});
```

**Path derivation note:** In production, `LegionProcess.js` lives at `packages/runtime/dist/LegionProcess.js`, so `join(_dirname, '..', '..', 'web', 'dist')` → `packages/web/dist`. In dev, `LegionProcess.ts` lives at `packages/runtime/src/LegionProcess.ts`, so `join(_dirname, '..', '..', '..', 'web')` → `packages/web`.

- [ ] **Step 3: Verify TypeScript is happy (will fail until Task 5 adds `webSrcPath`/`dev` to `WebConnectorDeps`)**

```bash
npm run typecheck 2>&1 | grep -A2 "WebConnector"
```

Expected: errors about unknown properties `webSrcPath` and `dev` on `WebConnectorDeps`. That's correct — they get fixed in Task 5.

- [ ] **Step 4: Commit**

Note: TypeScript will report errors about unknown properties `webSrcPath` and `dev` on `WebConnectorDeps` until Task 5 is complete. Complete Task 5 before running `npm run typecheck`.

```bash
git add packages/runtime/src/LegionProcess.ts
git commit -m "feat(dev): thread dev option and webSrcPath through LegionProcess.start()"
```

---

## Task 5: Add Vite middleware dev branch to `WebConnector`

**Files:**
- Modify: `packages/runtime/src/server/WebConnector.ts`

This is the core change. When `dev: true`, instead of serving static files from `dist/`, we spin up a Vite dev server in middleware mode and hand it all unmatched requests. Vite handles HMR, transforms, and the SPA fallback.

- [ ] **Step 1: Update `WebConnectorDeps` to include `dev` and `webSrcPath`**

Replace the existing `WebConnectorDeps` interface:

```ts
export interface WebConnectorDeps {
  collective: Collective;
  credentials: CredentialStore;
  eventBus: EventBus;
  serverConfig?: ServerConfig;
  /** Absolute path to built SPA files (packages/web/dist). Used in production. */
  webDistPath?: string;
  /** Absolute path to the web package root (packages/web). Used in dev mode. */
  webSrcPath?: string;
  /** When true, serve the SPA via Vite middleware with HMR instead of static files. */
  dev?: boolean;
}
```

- [ ] **Step 2: Add a `viteServer` private field to track the Vite instance**

Inside the `WebConnector` class, alongside the existing private fields, add:

```ts
private viteServer?: import('vite').ViteDevServer;
```

- [ ] **Step 3: Replace the static plugin block with a dev/prod branch in `start()`**

The current static-serving block is lines 51–61:

```ts
const { webDistPath } = this.deps;
if (webDistPath && existsSync(webDistPath)) {
  await app.register(staticPlugin, {
    root: webDistPath,
    wildcard: false,
  });
  // SPA client-side routing fallback
  app.setNotFoundHandler((_req, reply) => {
    void reply.sendFile('index.html');
  });
}
```

Replace it with:

```ts
if (this.deps.dev) {
  // ── Dev mode: Vite middleware with HMR ───────────────────────────────
  const { webSrcPath } = this.deps;
  if (!webSrcPath) {
    throw new Error('[WebConnector] dev mode requires webSrcPath');
  }
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({
    root: webSrcPath,
    server: { middlewareMode: true },
    appType: 'spa',
  });
  this.viteServer = vite;
  // Register Vite middleware — must come AFTER Fastify routes so API routes take priority
  app.addHook('onRequest', async (req, reply) => {
    // Skip Fastify-handled routes
    if (
      req.url.startsWith('/api/') ||
      req.url.startsWith('/ws') ||
      req.url === '/health'
    ) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      vite.middlewares(req.raw, reply.raw, (err?: unknown) => {
        if (err) reject(err as Error);
        else resolve();
      });
    });
    // Vite has handled the response — prevent Fastify from sending a 404
    reply.hijack();
  });
  console.log('  [dev] Vite HMR middleware active');
} else {
  // ── Production: serve pre-built static files ─────────────────────────
  const { webDistPath } = this.deps;
  if (webDistPath && existsSync(webDistPath)) {
    await app.register(staticPlugin, {
      root: webDistPath,
      wildcard: false,
    });
    // SPA client-side routing fallback
    app.setNotFoundHandler((_req, reply) => {
      void reply.sendFile('index.html');
    });
  }
}
```

- [ ] **Step 4: Close the Vite server in `stop()`**

Replace the existing `stop()` method:

```ts
async stop(): Promise<void> {
  this.connections.clear();
  await this.viteServer?.close();
  this.viteServer = undefined;
  await this.app?.close();
  this.app = undefined;
}
```

- [ ] **Step 5: Remove unused `existsSync` import if it is only used in the static branch**

The `existsSync` import at line 1 is still used in the production branch, so leave it.

- [ ] **Step 6: Run the full type-check to verify no errors**

```bash
npm run typecheck
```

Expected: exits 0 with no errors. If you see errors about `import('vite')`, ensure `vite` is in `packages/web/devDependencies` (it already is) and that the workspace root `node_modules` has it hoisted (run `npm install` if needed).

- [ ] **Step 7: Run existing WebConnector tests to confirm nothing is broken**

```bash
npx vitest run packages/runtime/src/server/WebConnector.test.ts
```

Expected: all tests pass. The tests don't pass `dev: true` so the production code path is exercised.

- [ ] **Step 8: Commit**

```bash
git add packages/runtime/src/server/WebConnector.ts
git commit -m "feat(dev): add Vite middleware dev branch to WebConnector"
```

---

## Task 6: Manual end-to-end verification

**Files:** none — verification only

- [ ] **Step 1: Start the dev server**

```bash
npm run dev
```

Expected output (within ~3s):

```
Starting Legion runtime in: /path/to/legion-v2 [dev]
  [dev] Vite HMR middleware active
  Web UI: http://127.0.0.1:3000
```

If you see a bootstrap password block, that's expected on first run (new `.legion/` directory).

- [ ] **Step 2: Open the app in a browser**

Navigate to `http://127.0.0.1:3000`. The Legion web UI should load. Open browser DevTools → Network tab and confirm there are no 404s for `.vue` or `.ts` source files.

- [ ] **Step 3: Verify Vue HMR works**

Edit any `.vue` file in `packages/web/src/` (e.g. add a comment or change a colour class). Save. The browser should update **without a full page reload** (HMR). The terminal should show a Vite HMR log line like `[vite] hmr update /src/components/...`.

- [ ] **Step 4: Verify backend restart on TypeScript change**

Edit any `.ts` file in `packages/runtime/src/` (e.g. add a `// dev-test` comment to `WebConnector.ts`). Save. The terminal should show `tsx` restarting the process (you'll see the startup log again within ~2s). The browser should reconnect automatically.

- [ ] **Step 5: Verify core/types changes also trigger restart**

Edit any `.ts` file in `packages/core/src/` (e.g. add a comment to `packages/core/src/index.ts`). Save. Confirm the backend restarts (same as Step 4). This validates the path aliases in `tsconfig.dev.json` are working — `tsx` is watching these files too.

- [ ] **Step 6: Verify production path is unaffected**

```bash
npm run build && npm start
```

Expected: server starts normally, serves pre-built static files from `packages/web/dist/`, no mention of `[dev]` or Vite in the output.

- [ ] **Step 7: Final commit**

```bash
git add .
git commit -m "feat(dev): complete dev hot-reload flow — tsx + Vite middleware"
```
