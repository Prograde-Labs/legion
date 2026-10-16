// packages/runtime/src/LegionProcess.loader.test.ts
import { describe, expect, it, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ConnectorRegistry } from '@legion-collective/core';
import type { ConnectorContext, ConnectorRuntimeDeps } from '@legion-collective/core';
import type { ConnectorConfig } from '@legion-collective/types';
import { startExternalConnectors } from './LegionProcess.js';

// Mirror of packages/core/src/connectors/loader.test.ts stubContext.
const stubContext = {
  submit: async () => undefined,
  callTool: async () => undefined,
  streamTool: async () => undefined,
  registry: {
    register: () => undefined,
    getAll: () => [],
    get: () => undefined,
    has: () => false,
    deregister: () => undefined,
  },
} as unknown as ConnectorContext;

const stubCollective = {
  list: () => [],
  get: () => undefined,
  findByIdentity: () => undefined,
  getOrThrow: () => undefined,
};

const stubSecretStore = { getSecret: async () => null };

function tmpWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'legion-loader-wiring-'));
}

function writeModule(dir: string, name: string, code: string): string {
  mkdirSync(join(dir, name), { recursive: true });
  const file = join(dir, name, 'index.mjs');
  writeFileSync(file, code);
  return file;
}

// Fixture that captures the runtime deps it was constructed with and the
// context it was started with, for the wiring assertions below.
const CAPTURING = `
let received;
let receivedDeps;
export function connector(options, deps) {
  receivedDeps = deps;
  return {
    name: options?.name ?? 'ext',
    start: async (ctx) => { received = ctx; },
    deliver: async () => {},
    stop: async () => {},
  };
}
export function receivedContext() { return received; }
export function receivedRuntimeDeps() { return receivedDeps; }
export default connector;
`;

const BROKEN = 'export syntax !!!';

// Fixture that self-reports the name of a connector already registered in the
// ConnectorRegistry (e.g. the builtin 'web') — exercises the dup-name guard.
const NAME_COLLIDER = `
export function connector() {
  return {
    name: 'web',
    start: async () => {},
    deliver: async () => {},
    stop: async () => {},
  };
}
export default connector;
`;

function runtimeDeps(): ConnectorRuntimeDeps {
  return { collective: stubCollective, secrets: stubSecretStore };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('startExternalConnectors (LegionProcess boot seam)', () => {
  it('starts, registers, and returns configured external connectors with the shared context', async () => {
    const ws = tmpWorkspace();
    const file = writeModule(ws, 'good', CAPTURING);
    const logSpy = vi.spyOn(console, 'log');

    const registry = new ConnectorRegistry();
    const entries: ConnectorConfig[] = [{ name: 'ext', module: file, options: { name: 'ext' } }];
    const names = await startExternalConnectors({
      entries,
      workspaceRoot: ws,
      connectorRegistry: registry,
      runtimeDeps: runtimeDeps(),
      context: stubContext,
    });

    // (a) returned names match the loaded connectors
    expect(names).toEqual(['ext']);
    // (b) registered in the real ConnectorRegistry
    expect(registry.get('ext')).toBeDefined();
    // every loaded connector is logged (ruling: no name special-casing)
    expect(logSpy).toHaveBeenCalledWith("[legion] external connector 'ext' started");

    const mod = (await import(pathToFileURL(file).href)) as {
      receivedContext: () => unknown;
      receivedRuntimeDeps: () => { collective: unknown; secrets: unknown };
    };
    // runtime deps threading: factory received the deps incl. the secret store
    expect(mod.receivedRuntimeDeps().collective).toBe(stubCollective);
    expect(mod.receivedRuntimeDeps().secrets).toBe(stubSecretStore);
    // context threading: start() received the exact shared ConnectorContext object
    expect(mod.receivedContext()).toBe(stubContext);
  });

  it('does not throw on a broken module and leaves it unregistered', async () => {
    const ws = tmpWorkspace();
    const brokenFile = writeModule(ws, 'broken', BROKEN);
    const goodFile = writeModule(ws, 'good', CAPTURING);
    const warnSpy = vi.spyOn(console, 'warn');

    const registry = new ConnectorRegistry();
    const entries: ConnectorConfig[] = [
      { name: 'broken', module: brokenFile },
      { name: 'good', module: goodFile, options: { name: 'good' } },
    ];
    const names = await startExternalConnectors({
      entries,
      workspaceRoot: ws,
      connectorRegistry: registry,
      runtimeDeps: runtimeDeps(),
      context: stubContext,
    });

    expect(names).toEqual(['good']);
    expect(registry.get('broken')).toBeUndefined();
    expect(registry.get('good')).toBeDefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('1 external connector(s) failed to load'),
    );
  });

  it('warns and skips an external whose self-reported name is already registered', async () => {
    const ws = tmpWorkspace();
    const colliderFile = writeModule(ws, 'collider', NAME_COLLIDER);
    const goodFile = writeModule(ws, 'good', CAPTURING);
    const warnSpy = vi.spyOn(console, 'warn');

    const registry = new ConnectorRegistry();
    registry.register({
      name: 'web',
      start: async () => {},
      deliver: async () => {},
      stop: async () => {},
    } as any);

    const entries: ConnectorConfig[] = [
      { name: 'web-collider', module: colliderFile }, // config name differs; connector self-reports 'web'
      { name: 'good', module: goodFile, options: { name: 'good' } },
    ];
    // Must not throw — the dup-name collision is a warning, not a boot crash.
    const names = await startExternalConnectors({
      entries,
      workspaceRoot: ws,
      connectorRegistry: registry,
      runtimeDeps: runtimeDeps(),
      context: stubContext,
    });

    // Returned names reflect successfully registered connectors only.
    expect(names).toEqual(['good']);
    // The original builtin stub is still the registered 'web'.
    expect(registry.get('web')?.name).toBe('web');
    // The good connector is unaffected.
    expect(registry.get('good')).toBeDefined();
    // Collision produced a skip warning mentioning the self-reported name.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("external connector 'web' could not register"),
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('skipped'));
  });
});
