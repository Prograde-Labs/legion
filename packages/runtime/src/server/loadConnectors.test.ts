import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Connector, ConnectorContext } from '@legion/core';
import { ConnectorRegistry } from '@legion/core';
import type { ConnectorConfig } from '@legion/types';
import { loadAndStartConnectors } from './loadConnectors.js';

function fakeConnector(name: string): Connector {
  return {
    name,
    start: async () => undefined,
    deliver: async () => undefined,
    stop: async () => undefined,
  };
}

const noopContext = {} as ConnectorContext;

function baseDeps(overrides: Partial<Parameters<typeof loadAndStartConnectors>[0]> = {}) {
  return {
    configs: [] as ConnectorConfig[],
    connectorRegistry: new ConnectorRegistry(),
    workspaceRoot: '/tmp/does-not-matter',
    runtimeDeps: {} as never,
    createWebConnector: () => fakeConnector('web'),
    buildContext: () => noopContext,
    ...overrides,
  };
}

// -- built-in web -----------------------------------------------------------

it('registers and starts the built-in web connector by default', async () => {
  const registry = new ConnectorRegistry();
  const created: string[] = [];
  await loadAndStartConnectors(
    baseDeps({
      configs: [{ name: 'web' }],
      connectorRegistry: registry,
      createWebConnector: () => {
        created.push('web');
        return fakeConnector('web');
      },
    }),
  );
  expect(created).toEqual(['web']);
  expect(registry.get('web')).toBeDefined();
});

it('defaults to a single web connector entry when configs is empty', async () => {
  const registry = new ConnectorRegistry();
  await loadAndStartConnectors(baseDeps({ connectorRegistry: registry }));
  expect(registry.get('web')).toBeDefined();
});

it('skips disabled entries', async () => {
  const registry = new ConnectorRegistry();
  await loadAndStartConnectors(
    baseDeps({ configs: [{ name: 'web', enabled: false }], connectorRegistry: registry }),
  );
  expect(registry.get('web')).toBeUndefined();
});

it('propagates web connector construction failure (fail-fast)', async () => {
  await expect(
    loadAndStartConnectors(
      baseDeps({
        createWebConnector: () => {
          throw new Error('spa missing');
        },
      }),
    ),
  ).rejects.toThrow('spa missing');
});

// -- external modules -------------------------------------------------------

it('loads an external connector from an absolute module path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'legion-conn-'));
  const modPath = join(dir, 'my-connector.mjs');
  writeFileSync(
    modPath,
    'export function connector() { return { name: "ext", start: async () => {}, deliver: async () => {}, stop: async () => {} }; }',
  );
  const registry = new ConnectorRegistry();
  await loadAndStartConnectors(
    baseDeps({
      configs: [{ name: 'ext', module: modPath }],
      connectorRegistry: registry,
    }),
  );
  expect(registry.get('ext')).toBeDefined();
});

it('loads an external connector from a workspace-relative module path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'legion-conn-'));
  writeFileSync(
    join(dir, 'rel-connector.mjs'),
    'export function connector() { return { name: "rel", start: async () => {}, deliver: async () => {}, stop: async () => {} }; }',
  );
  const registry = new ConnectorRegistry();
  await loadAndStartConnectors(
    baseDeps({
      configs: [{ name: 'rel', module: './rel-connector.mjs' }],
      connectorRegistry: registry,
      workspaceRoot: dir,
    }),
  );
  expect(registry.get('rel')).toBeDefined();
});

it('resolves a bare specifier from the workspace root node_modules', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'legion-conn-'));
  const pkgDir = join(dir, 'node_modules', 'fake-connector');
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name: 'fake-connector', version: '1.0.0', type: 'module', main: 'index.js' }),
  );
  writeFileSync(
    join(pkgDir, 'index.js'),
    'export function connector() { return { name: "bare", start: async () => {}, deliver: async () => {}, stop: async () => {} }; }',
  );
  // require.resolve needs a real package entry; also symlink layout sanity
  const registry = new ConnectorRegistry();
  await loadAndStartConnectors(
    baseDeps({
      configs: [{ name: 'bare', module: 'fake-connector' }],
      connectorRegistry: registry,
      workspaceRoot: dir,
    }),
  );
  expect(registry.get('bare')).toBeDefined();
});

it('skips a broken external module and still boots the web connector', async () => {
  const errSpy: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errSpy.push(args.join(' '));
  });
  const registry = new ConnectorRegistry();
  await loadAndStartConnectors(
    baseDeps({
      configs: [
        { name: 'broken', module: '/definitely/not/anywhere/connector.mjs' },
        { name: 'web' },
      ],
      connectorRegistry: registry,
    }),
  );
  spy.mockRestore();
  expect(registry.get('broken')).toBeUndefined();
  expect(registry.get('web')).toBeDefined();
  expect(errSpy.some((line) => line.includes('broken'))).toBe(true);
});

it('skips an external module that exports no connector factory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'legion-conn-'));
  const modPath = join(dir, 'nofactory.mjs');
  writeFileSync(modPath, 'export const notAFactory = 1;');
  const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const registry = new ConnectorRegistry();
  await loadAndStartConnectors(
    baseDeps({ configs: [{ name: 'nof', module: modPath }], connectorRegistry: registry }),
  );
  spy.mockRestore();
  expect(registry.get('nof')).toBeUndefined();
});

it('passes options and runtimeDeps to the external factory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'legion-conn-'));
  const modPath = join(dir, 'opted.mjs');
  writeFileSync(
    modPath,
    `export function connector(options, deps) {
      globalThis.__lastFactoryArgs = { options, deps };
      return { name: 'opted', start: async () => {}, deliver: async () => {}, stop: async () => {} };
    }`,
  );
  const runtimeDeps = { collective: { marker: true }, eventBus: { marker: true } } as never;
  await loadAndStartConnectors(
    baseDeps({
      configs: [{ name: 'opted', module: modPath, options: { botTokenEnv: 'X' } }],
      runtimeDeps,
    }),
  );
  const args = (globalThis as Record<string, unknown>).__lastFactoryArgs as {
    options: Record<string, unknown>;
    deps: unknown;
  };
  expect(args.options).toEqual({ botTokenEnv: 'X' });
  expect(args.deps).toBe(runtimeDeps);
});

it('forwards entry defaultParticipantId into the factory options', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'legion-conn-'));
  const modPath = join(dir, 'opted-dpid.mjs');
  writeFileSync(
    modPath,
    `export function connector(options) {
      globalThis.__lastDpidFactoryOptions = options;
      return { name: 'dpid', start: async () => {}, deliver: async () => {}, stop: async () => {} };
    }`,
  );
  await loadAndStartConnectors(
    baseDeps({
      configs: [
        {
          name: 'dpid',
          module: modPath,
          options: { botTokenEnv: 'X', botToken: 'secret' },
          defaultParticipantId: 'guest',
        },
      ],
    }),
  );
  const options = (globalThis as Record<string, unknown>).__lastDpidFactoryOptions as Record<
    string,
    unknown
  >;
  expect(options).toEqual({
    botTokenEnv: 'X',
    botToken: 'secret',
    defaultParticipantId: 'guest',
  });
});

it('deregisters an external connector whose start() throws and keeps the process alive', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'legion-conn-'));
  const modPath = join(dir, 'badstart.mjs');
  writeFileSync(
    modPath,
    `export function connector() {
      return { name: 'badstart', start: async () => { throw new Error('bad token'); }, deliver: async () => {}, stop: async () => {} };
    }`,
  );
  const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const registry = new ConnectorRegistry();
  const web = fakeConnector('web');
  await loadAndStartConnectors(
    baseDeps({
      configs: [{ name: 'badstart', module: modPath }, { name: 'web' }],
      connectorRegistry: registry,
      createWebConnector: () => web,
    }),
  );
  spy.mockRestore();
  expect(registry.get('badstart')).toBeUndefined();
  expect(registry.get('web')).toBeDefined();
});

it('rejects duplicate connector names', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'legion-conn-'));
  const modPath = join(dir, 'dupe.mjs');
  writeFileSync(
    modPath,
    'export function connector() { return { name: "web", start: async () => {}, deliver: async () => {}, stop: async () => {} }; }',
  );
  await expect(
    loadAndStartConnectors(
      baseDeps({ configs: [{ name: 'web' }, { name: 'web', module: modPath }] }),
    ),
  ).rejects.toThrow(/already registered/);
});
