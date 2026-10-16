// packages/core/src/connectors/loader.test.ts
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadExternalConnectors } from './loader.js';
import type { Connector } from './Connector.js';
import type { ConnectorConfig } from '@legion-collective/types';

function tmpWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'legion-loader-'));
}

function writeModule(dir: string, name: string, code: string): string {
  mkdirSync(join(dir, name), { recursive: true });
  const file = join(dir, name, 'index.mjs');
  writeFileSync(file, code);
  return file;
}

const GOOD = `
export function connector(options, deps) {
  return {
    name: options?.name ?? 'ext',
    start: async () => {},
    deliver: async () => {},
    stop: async () => {},
  };
}
export default connector;
`;

describe('loadExternalConnectors', () => {
  it('imports a module by absolute path and requires a named connector factory', async () => {
    const ws = tmpWorkspace();
    writeModule(ws, 'good', GOOD);
    const entries: ConnectorConfig[] = [
      { name: 'ext', module: join(ws, 'good', 'index.mjs'), options: { name: 'ext' } },
    ];
    const { loaded, failures } = await loadExternalConnectors(entries, ws, {
      collective: {
        list: () => [],
        get: () => undefined,
        findByIdentity: () => undefined,
        getOrThrow: () => undefined,
      },
    });
    expect(failures).toEqual([]);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].name).toBe('ext');
    expect(typeof (loaded[0].connector as Connector).start).toBe('function');
  });

  it('logs-and-skips: broken module, missing export, non-function factory, start() throw', async () => {
    const ws = tmpWorkspace();
    writeModule(ws, 'broken', 'export syntax !!!');
    writeModule(ws, 'noexport', 'export const x = 1;');
    writeModule(ws, 'notfn', 'export function connector() { return 42; }');
    writeModule(
      ws,
      'throwing',
      `
      export function connector() {
        return { name: 't', start: () => { throw new Error('boom'); }, deliver: async () => {}, stop: async () => {} };
      }
    `,
    );
    const entries: ConnectorConfig[] = [
      { name: 'broken', module: join(ws, 'broken', 'index.mjs') },
      { name: 'noexport', module: join(ws, 'noexport', 'index.mjs') },
      { name: 'notfn', module: join(ws, 'notfn', 'index.mjs') },
      { name: 'throwing', module: join(ws, 'throwing', 'index.mjs') },
    ];
    const { loaded, failures } = await loadExternalConnectors(entries, ws, {
      collective: {
        list: () => [],
        get: () => undefined,
        findByIdentity: () => undefined,
        getOrThrow: () => undefined,
      },
    });
    expect(loaded).toEqual([]);
    expect(failures.map((f) => f.name)).toEqual(['broken', 'noexport', 'notfn', 'throwing']);
    expect(failures.every((f) => typeof f.reason === 'string' && f.reason.length > 0)).toBe(true);
  });

  it('skips entries without module or with enabled:false', async () => {
    const entries: ConnectorConfig[] = [
      { name: 'web' }, // builtin — loader ignores entries without module
      { name: 'off', module: 'does-not-matter', enabled: false },
    ];
    const { loaded, failures } = await loadExternalConnectors(entries, tmpWorkspace(), {
      collective: {
        list: () => [],
        get: () => undefined,
        findByIdentity: () => undefined,
        getOrThrow: () => undefined,
      },
    });
    expect(loaded).toEqual([]);
    expect(failures).toEqual([]);
  });

  it('merges defaultParticipantId into factory options', async () => {
    const ws = tmpWorkspace();
    const file = writeModule(
      ws,
      'cap',
      `
      export function connector(options) {
        return { name: 'cap', captured: options, start: async () => {}, deliver: async () => {}, stop: async () => {} };
      }
    `,
    );
    const entries: ConnectorConfig[] = [
      { name: 'cap', module: file, defaultParticipantId: 'fallback-user' },
    ];
    const { loaded } = await loadExternalConnectors(entries, ws, {
      collective: {
        list: () => [],
        get: () => undefined,
        findByIdentity: () => undefined,
        getOrThrow: () => undefined,
      },
    });
    expect(
      (loaded[0].connector as unknown as { captured: Record<string, unknown> }).captured,
    ).toMatchObject({ defaultParticipantId: 'fallback-user' });
  });

  it('resolves bare npm-style specs via workspace-relative paths', async () => {
    const ws = tmpWorkspace();
    mkdirSync(join(ws, 'local-conn'), { recursive: true });
    writeFileSync(join(ws, 'local-conn', 'index.mjs'), GOOD);
    const entries: ConnectorConfig[] = [{ name: 'local', module: './local-conn/index.mjs' }];
    const { loaded, failures } = await loadExternalConnectors(entries, ws, {
      collective: {
        list: () => [],
        get: () => undefined,
        findByIdentity: () => undefined,
        getOrThrow: () => undefined,
      },
    });
    expect(failures).toEqual([]);
    expect(loaded).toHaveLength(1);
  });

  it('duplicate connector names: last-wins with a warning', async () => {
    const ws = tmpWorkspace();
    const fileA = writeModule(
      ws,
      'a',
      `
      export function connector() {
        return { name: 'dup', first: true, start: async () => {}, deliver: async () => {}, stop: async () => {} };
      }
    `,
    );
    const fileB = writeModule(
      ws,
      'b',
      `
      export function connector() {
        return { name: 'dup', first: false, start: async () => {}, deliver: async () => {}, stop: async () => {} };
      }
    `,
    );
    const { loaded } = await loadExternalConnectors(
      [
        { name: 'dup', module: fileA },
        { name: 'dup', module: fileB },
      ],
      ws,
      {
        collective: {
          list: () => [],
          get: () => undefined,
          findByIdentity: () => undefined,
          getOrThrow: () => undefined,
        },
      },
    );
    expect(loaded).toHaveLength(1);
    expect((loaded[0].connector as unknown as { first: boolean }).first).toBe(false);
  });
});
