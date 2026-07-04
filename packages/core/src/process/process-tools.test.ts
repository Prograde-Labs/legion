import { processTools } from './process-tools.js';
import type { ToolContext } from '../tools/Tool.js';
import type { ProcessHandle, ExecuteResult } from '@legion/types';

const HANDLE: ProcessHandle = {
  id: 'proc-test',
  command: 'echo',
  args: [],
  cwd: '/tmp',
  tty: false,
  shell: false,
  startedAt: '2026-01-01T00:00:00.000Z',
  startedByParticipantId: 'user-1',
  pid: 1234,
  status: 'running',
  exitCode: null,
  exitedAt: null,
};

function makeCtx(overrides: Partial<ReturnType<typeof makeMockPm>> = {}): ToolContext {
  const pm = makeMockPm(overrides);
  return {
    participant: { id: 'user-1', type: 'user' } as any,
    conversationId: 'conv-1',
    conversation: {} as any,
    collective: {} as any,
    communicationDepth: 0,
    toolRegistry: {} as any,
    config: {} as any,
    eventBus: {} as any,
    storage: {} as any,
    workspaceRoot: '/tmp',
    processManager: pm,
  } as unknown as ToolContext;
}

function makeMockPm(overrides: Record<string, any> = {}) {
  return {
    start: vi.fn().mockResolvedValue(HANDLE),
    execute: vi.fn().mockResolvedValue({
      processId: 'proc-test',
      exitCode: 0,
      stdout: 'hello',
      stderr: '',
      durationMs: 100,
      timedOut: false,
    } satisfies ExecuteResult),
    list: vi.fn().mockResolvedValue([HANDLE]),
    get: vi.fn().mockReturnValue(HANDLE),
    readOutput: vi.fn().mockResolvedValue({ data: Buffer.from('hi'), totalBytes: 2, from: 0 }),
    writeInput: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function getTool(name: string) {
  const t = processTools.find((t) => t.name === name);
  if (!t) throw new Error(`Tool ${name} not found`);
  return t;
}

describe('process tools', () => {
  it('exports 8 tools', () => {
    expect(processTools).toHaveLength(8);
    const names = processTools.map((t) => t.name);
    expect(names).toContain('execute_command');
    expect(names).toContain('start_process');
    expect(names).toContain('list_processes');
    expect(names).toContain('get_process');
    expect(names).toContain('read_process_output');
    expect(names).toContain('write_process_input');
    expect(names).toContain('stop_process');
    expect(names).toContain('delete_process');
  });

  describe('execute_command', () => {
    it('calls pm.execute and returns result', async () => {
      const ctx = makeCtx();
      const tool = getTool('execute_command');
      const result = await tool.execute({ command: 'echo', args: ['hi'] }, ctx);
      expect((result as any).status).toBe('success');
      expect((result as any).data.stdout).toBe('hello');
    });

    it('returns error result on failure', async () => {
      const ctx = makeCtx({ execute: vi.fn().mockRejectedValue(new Error('ENOENT')) });
      const result = await getTool('execute_command').execute({ command: 'nope' }, ctx);
      expect((result as any).status).toBe('error');
    });
  });

  describe('start_process', () => {
    it('calls pm.start and returns handle', async () => {
      const ctx = makeCtx();
      const result = await getTool('start_process').execute(
        { command: 'sleep', args: ['10'] },
        ctx,
      );
      expect((result as any).status).toBe('success');
      expect((result as any).data.id).toBe('proc-test');
    });
  });

  describe('list_processes', () => {
    it('returns array of handles', async () => {
      const ctx = makeCtx();
      const result = await getTool('list_processes').execute({ status: 'all' }, ctx);
      expect((result as any).status).toBe('success');
      expect(Array.isArray((result as any).data)).toBe(true);
    });
  });

  describe('get_process', () => {
    it('returns handle for known id', async () => {
      const ctx = makeCtx();
      const result = await getTool('get_process').execute({ id: 'proc-test' }, ctx);
      expect((result as any).status).toBe('success');
    });

    it('returns error for unknown id', async () => {
      const ctx = makeCtx({ get: vi.fn().mockReturnValue(undefined) });
      const result = await getTool('get_process').execute({ id: 'proc-unknown' }, ctx);
      expect((result as any).status).toBe('error');
    });
  });

  describe('delete_process', () => {
    it('refuses running process', async () => {
      const ctx = makeCtx({
        delete: vi.fn().mockRejectedValue(new Error('Cannot delete running process')),
      });
      const result = await getTool('delete_process').execute({ id: 'proc-test' }, ctx);
      expect((result as any).status).toBe('error');
    });
  });

  describe('read_process_output', () => {
    it('returns utf8 decoded data by default', async () => {
      const ctx = makeCtx();
      const result = await getTool('read_process_output').execute({ id: 'proc-test' }, ctx);
      expect((result as any).status).toBe('success');
      expect((result as any).data.data).toBe('hi');
    });

    it('returns base64 when decode:base64', async () => {
      const ctx = makeCtx();
      const result = await getTool('read_process_output').execute(
        { id: 'proc-test', decode: 'base64' },
        ctx,
      );
      expect((result as any).data.data).toBe(Buffer.from('hi').toString('base64'));
    });
  });
});
