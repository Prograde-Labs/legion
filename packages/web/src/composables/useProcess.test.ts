import { describe, it, expect, vi, beforeEach } from 'vitest';
import { defineComponent } from 'vue';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';

// Module-level WS handler tracking for the mock
const wsHandlers = new Set<(data: unknown) => void>();
const wsSendMock = vi.fn();

vi.mock('./useWebSocket.js', () => ({
  useWebSocket: () => ({
    send: wsSendMock,
    onMessage: (h: (data: unknown) => void) => {
      wsHandlers.add(h);
      return () => wsHandlers.delete(h);
    },
    connect: vi.fn(),
    disconnect: vi.fn(),
  }),
}));

const executeMock = vi.fn();
vi.mock('./useExecute.js', () => ({
  useExecute: () => ({ execute: executeMock }),
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

function emit(data: unknown): void {
  for (const h of wsHandlers) h(data);
}

beforeEach(() => {
  vi.clearAllMocks();
  wsHandlers.clear();
  vi.resetModules();
});

describe('useProcess', () => {
  it('fetches handle on load', async () => {
    const { useProcess } = await import('./useProcess.js');
    executeMock.mockResolvedValueOnce(RUNNING_HANDLE); // get_process
    executeMock.mockResolvedValueOnce({ data: btoa('hello'), totalBytes: 5, from: 0 }); // read_process_output

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

  it('sends subscribe_process for running process', async () => {
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
    expect(wsSendMock).toHaveBeenCalledWith({ type: 'subscribe_process', processId: 'proc-1' });
    w.unmount();
  });

  it('does not subscribe for exited process', async () => {
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
    expect(wsSendMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'subscribe_process' }),
    );
    w.unmount();
  });

  it('appends chunk on process:output message', async () => {
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

    emit({
      type: 'process:output',
      processId: 'proc-1',
      stream: 'stdout',
      data: btoa('new line\n'),
    });
    await nextTick();

    expect((w.vm as any).chunks).toContain('new line\n');
    w.unmount();
  });

  it('ignores process:output for a different processId', async () => {
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
    const before = (w.vm as any).chunks.length;

    emit({ type: 'process:output', processId: 'proc-OTHER', stream: 'stdout', data: btoa('nope') });
    await nextTick();

    expect((w.vm as any).chunks.length).toBe(before);
    w.unmount();
  });

  it('updates handle status on process:exited', async () => {
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

    emit({ type: 'process:exited', processId: 'proc-1', exitCode: 0, signal: null });
    await nextTick();

    expect((w.vm as any).handle?.status).toBe('exited');
    expect((w.vm as any).handle?.exitCode).toBe(0);
    w.unmount();
  });

  it('sends unsubscribe_process on unmount', async () => {
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
    wsSendMock.mockClear();

    w.unmount();
    expect(wsSendMock).toHaveBeenCalledWith({ type: 'unsubscribe_process', processId: 'proc-1' });
  });

  it('stop() calls stop_process and updates handle', async () => {
    const { useProcess } = await import('./useProcess.js');
    const stoppedHandle = {
      ...RUNNING_HANDLE,
      status: 'killed',
      exitCode: null,
      exitedAt: '2026-01-01T00:01:00.000Z',
    };
    executeMock.mockResolvedValueOnce(RUNNING_HANDLE); // get_process
    executeMock.mockResolvedValueOnce({ data: btoa(''), totalBytes: 0, from: 0 }); // read_output
    executeMock.mockResolvedValueOnce(stoppedHandle); // stop_process

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
