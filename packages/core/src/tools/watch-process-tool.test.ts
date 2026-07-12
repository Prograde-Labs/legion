import { watchProcessTool } from './watch-process-tool.js';
import { EventBus } from '../events/EventBus.js';
import type { ToolContext } from './Tool.js';
import type { StreamChunk } from '@legion/types';

function makeMockProcessManager(processId: string, ownerId: string) {
  const listeners: Record<string, Array<(evt: unknown) => void>> = {
    output: [],
    exited: [],
    error: [],
  };
  return {
    get: (id: string) =>
      id === processId ? { id, status: 'running', startedByParticipantId: ownerId } : undefined,
    subscribe: (id: string, event: string, cb: (evt: unknown) => void) => {
      listeners[event]?.push(cb);
      return () => {
        const arr = listeners[event];
        if (arr) {
          const idx = arr.indexOf(cb);
          if (idx >= 0) arr.splice(idx, 1);
        }
      };
    },
    emit: (event: string, data: unknown) => {
      listeners[event]?.forEach((cb) => cb(data));
    },
  };
}

function fakeCtx(
  pm: ReturnType<typeof makeMockProcessManager>,
  participantId: string,
  signal?: AbortSignal,
): ToolContext {
  return {
    participant: { id: participantId, name: 'P', type: 'user', tools: {}, status: 'active' },
    conversationId: '',
    eventBus: new EventBus(),
    processManager: pm,
    signal,
  } as unknown as ToolContext;
}

describe('watch_process tool', () => {
  it('yields process:output chunks from processManager', async () => {
    const pm = makeMockProcessManager('proc-1', 'owner-1');
    const controller = new AbortController();
    const gen = watchProcessTool.stream(
      { processId: 'proc-1' },
      fakeCtx(pm, 'owner-1', controller.signal),
    );

    const chunks: StreamChunk[] = [];
    const consumer = (async () => {
      for await (const chunk of gen) chunks.push(chunk);
    })();

    // Let generator body run and subscribe before emitting
    await Promise.resolve();
    pm.emit('output', { stream: 'stdout', data: Buffer.from('hello') });
    // Let the generator drain the chunk before aborting
    await new Promise((r) => setTimeout(r, 0));
    controller.abort();
    await consumer;

    expect(chunks[0]).toMatchObject({
      type: 'process:output',
      processId: 'proc-1',
      stream: 'stdout',
    });
  });

  it('terminates after process:exited', async () => {
    const pm = makeMockProcessManager('proc-1', 'owner-1');
    const gen = watchProcessTool.stream({ processId: 'proc-1' }, fakeCtx(pm, 'owner-1'));

    const chunks: StreamChunk[] = [];
    const consumer = (async () => {
      for await (const chunk of gen) chunks.push(chunk);
    })();

    // Let generator body run and subscribe before emitting
    await Promise.resolve();
    pm.emit('exited', { exitCode: 0, signal: null });
    // Let the generator drain and terminate
    await new Promise((r) => setTimeout(r, 0));
    await consumer;

    expect(chunks[chunks.length - 1]).toMatchObject({ type: 'process:exited', exitCode: 0 });
  });

  it('throws when process not found', async () => {
    const pm = makeMockProcessManager('proc-1', 'owner-1');
    const gen = watchProcessTool.stream({ processId: 'nope' }, fakeCtx(pm, 'owner-1'));
    await expect(async () => {
      for await (const _c of gen) {
        /* noop */
      }
    }).rejects.toThrow(/not found/i);
  });

  it('throws when participant is not the owner and not operator', async () => {
    const pm = makeMockProcessManager('proc-1', 'owner-1');
    const gen = watchProcessTool.stream({ processId: 'proc-1' }, fakeCtx(pm, 'other-user'));
    await expect(async () => {
      for await (const _c of gen) {
        /* noop */
      }
    }).rejects.toThrow(/not authorized/i);
  });
});
