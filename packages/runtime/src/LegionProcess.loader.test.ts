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
});
