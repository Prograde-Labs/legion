# Dev Hot-Reload Flow — Design Spec

**Date:** 2026-07-03
**Status:** Approved

## Goal

Replace the current full-rebuild-on-every-change workflow with a development mode that gives instant feedback for both the Vue frontend (HMR) and the Node.js backend (process restart on file change), with zero pre-build required.

## Background

The monorepo has five packages:

| Package            | Role                                 |
| ------------------ | ------------------------------------ |
| `packages/types`   | Shared TypeScript types              |
| `packages/core`    | Business logic engine                |
| `packages/runtime` | Fastify server + WebSocket connector |
| `packages/web`     | Vue 3 + Vite SPA                     |
| `packages/e2e`     | Playwright tests                     |

Currently `packages/core`, `packages/types`, and `packages/runtime` must be compiled to `dist/` before anything can run. `bin/legion.js` imports from `packages/runtime/dist/`. Changes to any TypeScript source require a full `tsc --build` before they are visible.

## Approach

### tsx path aliases (zero build)

Run the backend with `tsx --watch` (TypeScript executed directly via esbuild — no compile step). Use `tsconfig.dev.json` path aliases to redirect workspace package imports from their compiled `dist/` to their TypeScript source. This means changes to any file in `types`, `core`, or `runtime` are picked up immediately without any compilation step.

The Vite dev server runs embedded inside Fastify as middleware instead of `@fastify/static`. All traffic (API, WebSocket, SPA, HMR) remains on a single port — no proxy configuration, no cross-origin issues, no future concerns around response streaming.

## Developer Workflow

```bash
npm run dev   # start everything
# edit any .ts file in core/types/runtime → backend restarts in ~1-2s
# edit any .vue file or .ts in web/src → browser updates instantly via HMR
```

No pre-build step required. A fresh clone only needs `npm install` before `npm run dev`.

## Architecture

### Single entrypoint: `bin/legion.js --dev`

The existing `packages/runtime/bin/legion.js` is extended to accept a `--dev` CLI flag. No new entrypoint file is created. The flag is detected at startup and passed through `LegionProcess.start(workspaceRoot, { dev })`.

### `tsconfig.dev.json` (new, at repo root)

A root-level TypeScript config used exclusively by `tsx` during development. It extends `tsconfig.base.json` and adds `paths` aliases that map each workspace package import to its TypeScript source:

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

`tsx` respects these paths when running `bin/legion.js`, so it resolves `@legion/core` to `packages/core/src/index.ts` rather than `packages/core/dist/index.js`. No dist build is required.

### Dev mode branch in `WebConnector`

`WebConnectorDeps` gains an optional `dev?: boolean` flag. When `dev: true`:

- `@fastify/static` is **not** registered
- Vite's `createServer({ server: { middlewareMode: true }, root: '<path-to-packages/web>' })` is called dynamically (via `import('vite')`) and its middleware is registered on the Fastify instance
- The SPA fallback is handled by Vite's `appType: 'spa'` setting
- The Vite instance is stored and closed during `WebConnector.stop()`

When `dev: false` (default, production), behavior is identical to today.

Vite is imported dynamically (`await import('vite')`) so it is never loaded in production even if present in `devDependencies`.

### Data flow in dev mode

```
Browser
  ├── GET /  → Vite middleware → serves index.html with HMR client injected
  ├── GET /__vite_hmr → Vite HMR WebSocket (handled by Vite middleware)
  ├── GET /src/... → Vite middleware → transforms and serves Vue/TS source
  ├── POST /api/... → Fastify routes (auth, execute)
  └── GET /ws → Fastify WebSocket route → Legion WebSocket handler
```

All on one port. Vite middleware is registered last so Fastify routes take priority.

### Root `package.json` changes

New script:

```json
"dev": "tsx --watch --tsconfig tsconfig.dev.json packages/runtime/bin/legion.js --dev"
```

New devDependencies:

```json
"tsx": "^4.0.0"
```

`vite` is already a devDependency of `packages/web`. It does not need to be added to the root or to `packages/runtime` because the dynamic `import('vite')` will resolve it through the workspace `node_modules`.

## Files Changed

| File                                          | Change                                                                       |
| --------------------------------------------- | ---------------------------------------------------------------------------- |
| `tsconfig.dev.json`                           | New — path aliases for tsx                                                   |
| `packages/runtime/bin/legion.js`              | Parse `--dev` flag, pass `{ dev }` to `LegionProcess.start()`                |
| `packages/runtime/src/LegionProcess.ts`       | Accept `options?: { dev?: boolean }`, thread `dev` to `WebConnector`         |
| `packages/runtime/src/server/WebConnector.ts` | Add `dev?: boolean` to deps; swap static plugin for Vite middleware when dev |
| `package.json`                                | Add `dev` script, add `tsx` devDependency                                    |

## Error Handling

- If `import('vite')` fails in dev mode (e.g. vite not installed), throw a clear error: `"Vite is required for dev mode — run npm install in packages/web"`
- If the `--dev` flag is passed but `packages/web` source directory is not found, throw with the expected path
- Production startup (no `--dev`) is completely unaffected by all of the above

## Testing

- Dev mode is a developer tooling concern; no unit tests are added
- The existing `WebConnector` tests continue to pass unmodified (they don't set `dev: true`)
- Manual verification: `npm run dev`, open browser, edit a `.vue` file, confirm HMR update; edit a `.ts` file in `core`, confirm backend restart and reconnect
