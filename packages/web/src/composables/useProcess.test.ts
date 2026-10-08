import { describe, it, expect, vi, beforeEach } from 'vitest';
import { defineComponent } from 'vue';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';

// Capture the onChunk handler from useToolStream so tests can emit chunks
let capturedOnChunk: ((chunk: unknown) => void) | null = null;
const startMock = vi.fn().mockResolvedValue(undefined);
const cancelMock = vi.fn().mockResolvedValue(undefined);

vi.mock('./useToolStream.js', () => ({
  useToolStream: (
    _tool: string,
    _args: () => unknown,
    opts?: { onChunk?: (c: unknown) => void },
  ) => {
    capturedOnChunk = opts?.onChunk ?? null;
    return {
      start: startMock,
      cancel: cancelMock,
      chunks: { value: [] },
      done: { value: false },
      error: { value: null },
      conversationId: { value: null },
    };
  },
}));

vi.mock('./useWebSocket.js', () => ({
  useWebSocket: () => ({
    getConnectionId: () => 'conn-test',
    connect: vi.fn(),
    disconnect: vi.fn(),
    onMessage: vi.fn(() => () => {}),
    send: vi.fn(),
    onStreamChunk: vi.fn(() => () => {}),
  }),
}));

const executeMock = vi.fn();
vi.mock('./useLegionApi.js', () => ({
  useLegionApi: () => ({ execute: executeMock }),
}));

const RUNNING_HANDLE = {
  id: 'proc-1',
  command: 'sleep',
  args: ['30'],
  cwd: '/tmp',
  tty: false,
  shell: false,
  startedAt: '2026-01-01T00:00:00.000Z',
  startedByParticipantId: 'op',
  pid: 9999,
  status: 'running',
  exitCode: null,
  exitedAt: null,
};

const EXITED_HANDLE = {
  ...RUNNING_HANDLE,
  status: 'exited',
  exitCode: 0,
  exitedAt: '2026-01-01T00:00:30.000Z',
};

function emitChunk(chunk: unknown): void {
  if (capturedOnChunk) capturedOnChunk(chunk);
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedOnChunk = null;
  vi.resetModules();
});

describe('useProcess', () => {
  it('fetches handle on load', async () => {
    const { useProcess } = await import('./useProcess.js');
    executeMock.mockResolvedValueOnce(RUNNING_HANDLE);
    executeMock.mockResolvedValueOnce({ data: btoa('hello'), totalBytes: 5, from: 0 });

    const TestComponent = defineComponent({
      setup() {
        return useProcess('proc-1');
      },
      template: '<div/>',
    });
    const w = mount(TestComponent);
    await nextTick();
    await new Promise((r) => setTimeout(r, 0));
    expect((w.vm as any).handle?.id).toBe('proc-1');
    w.unmount();
  });

  it('loads output tail for running process', async () => {
    const { useProcess } = await import('./useProcess.js');
    executeMock.mockResolvedValueOnce(RUNNING_HANDLE);
    executeMock.mockResolvedValueOnce({ data: btoa('hello world'), totalBytes: 11, from: 0 });

    const TestComponent = defineComponent({
      setup() {
        return useProcess('proc-1');
      },
      template: '<div/>',
    });
    const w = mount(TestComponent);
    await new Promise((r) => setTimeout(r, 0));
    expect((w.vm as any).chunks).toContain('hello world');
    w.unmount();
  });

  it('starts watch_process stream for running process', async () => {
    const { useProcess } = await import('./useProcess.js');
    executeMock.mockResolvedValueOnce(RUNNING_HANDLE);
    executeMock.mockResolvedValueOnce({ data: btoa(''), totalBytes: 0, from: 0 });

    const TestComponent = defineComponent({
      setup() {
        return useProcess('proc-1');
      },
      template: '<div/>',
    });
    const w = mount(TestComponent);
    await new Promise((r) => setTimeout(r, 0));
    expect(startMock).toHaveBeenCalled();
    w.unmount();
  });

  it('does not start stream for exited process', async () => {
    const { useProcess } = await import('./useProcess.js');
    executeMock.mockResolvedValueOnce(EXITED_HANDLE);
    executeMock.mockResolvedValueOnce({ data: btoa('old output'), totalBytes: 10, from: 0 });

    const TestComponent = defineComponent({
      setup() {
        return useProcess('proc-1');
      },
      template: '<div/>',
    });
    const w = mount(TestComponent);
    await new Promise((r) => setTimeout(r, 0));
    expect(startMock).not.toHaveBeenCalled();
    w.unmount();
  });

  it('appends chunk on process:output stream chunk', async () => {
    const { useProcess } = await import('./useProcess.js');
    executeMock.mockResolvedValueOnce(RUNNING_HANDLE);
    executeMock.mockResolvedValueOnce({ data: btoa(''), totalBytes: 0, from: 0 });

    const TestComponent = defineComponent({
      setup() {
        return useProcess('proc-1');
      },
      template: '<div/>',
    });
    const w = mount(TestComponent);
    await new Promise((r) => setTimeout(r, 0));

    emitChunk({
      type: 'process:output',
      processId: 'proc-1',
      stream: 'stdout',
      data: btoa('new line\n'),
    });
    await nextTick();

    expect((w.vm as any).chunks).toContain('new line\n');
    w.unmount();
  });

  it('updates handle status on process:exited stream chunk', async () => {
    const { useProcess } = await import('./useProcess.js');
    executeMock.mockResolvedValueOnce(RUNNING_HANDLE);
    executeMock.mockResolvedValueOnce({ data: btoa(''), totalBytes: 0, from: 0 });

    const TestComponent = defineComponent({
      setup() {
        return useProcess('proc-1');
      },
      template: '<div/>',
    });
    const w = mount(TestComponent);
    await new Promise((r) => setTimeout(r, 0));

    emitChunk({ type: 'process:exited', processId: 'proc-1', exitCode: 0, signal: null });
    await nextTick();

    expect((w.vm as any).handle?.status).toBe('exited');
    expect((w.vm as any).handle?.exitCode).toBe(0);
    w.unmount();
  });

  it('cancels stream on unmount', async () => {
    const { useProcess } = await import('./useProcess.js');
    executeMock.mockResolvedValueOnce(RUNNING_HANDLE);
    executeMock.mockResolvedValueOnce({ data: btoa(''), totalBytes: 0, from: 0 });

    const TestComponent = defineComponent({
      setup() {
        return useProcess('proc-1');
      },
      template: '<div/>',
    });
    const w = mount(TestComponent);
    await new Promise((r) => setTimeout(r, 0));

    w.unmount();
    expect(cancelMock).toHaveBeenCalled();
  });

  it('stop() calls stop_process and updates handle', async () => {
    const { useProcess } = await import('./useProcess.js');
    const stoppedHandle = {
      ...RUNNING_HANDLE,
      status: 'killed',
      exitCode: null,
      exitedAt: '2026-01-01T00:01:00.000Z',
    };
    executeMock.mockResolvedValueOnce(RUNNING_HANDLE);
    executeMock.mockResolvedValueOnce({ data: btoa(''), totalBytes: 0, from: 0 });
    executeMock.mockResolvedValueOnce(stoppedHandle);

    const TestComponent = defineComponent({
      setup() {
        return useProcess('proc-1');
      },
      template: '<div/>',
    });
    const w = mount(TestComponent);
    await new Promise((r) => setTimeout(r, 0));

    await (w.vm as any).stop();
    expect(executeMock).toHaveBeenCalledWith('stop_process', { id: 'proc-1' });
    expect((w.vm as any).handle?.status).toBe('killed');
    w.unmount();
  });

  it('send() calls write_process_input', async () => {
    const { useProcess } = await import('./useProcess.js');
    executeMock.mockResolvedValueOnce(RUNNING_HANDLE);
    executeMock.mockResolvedValueOnce({ data: btoa(''), totalBytes: 0, from: 0 });
    executeMock.mockResolvedValueOnce({ ok: true });

    const TestComponent = defineComponent({
      setup() {
        return useProcess('proc-1');
      },
      template: '<div/>',
    });
    const w = mount(TestComponent);
    await new Promise((r) => setTimeout(r, 0));

    await (w.vm as any).send('hello\n');
    expect(executeMock).toHaveBeenCalledWith('write_process_input', {
      id: 'proc-1',
      data: 'hello\n',
    });
    w.unmount();
  });

  it('del() calls delete_process', async () => {
    const { useProcess } = await import('./useProcess.js');
    executeMock.mockResolvedValueOnce(EXITED_HANDLE);
    executeMock.mockResolvedValueOnce({ data: btoa(''), totalBytes: 0, from: 0 });
    executeMock.mockResolvedValueOnce({ ok: true, id: 'proc-1' });

    const TestComponent = defineComponent({
      setup() {
        return useProcess('proc-1');
      },
      template: '<div/>',
    });
    const w = mount(TestComponent);
    await new Promise((r) => setTimeout(r, 0));

    await (w.vm as any).del();
    expect(executeMock).toHaveBeenCalledWith('delete_process', { id: 'proc-1' });
    w.unmount();
  });
});
