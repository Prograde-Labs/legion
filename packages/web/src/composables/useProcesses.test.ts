import { describe, it, expect, vi, beforeEach } from 'vitest';
import { defineComponent } from 'vue';
import { mount } from '@vue/test-utils';

vi.mock('./useExecute.js', () => ({
  useExecute: vi.fn(() => ({
    execute: vi.fn().mockResolvedValue([]),
  })),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

describe('useProcesses', () => {
  it('exports processes, loading, error, refresh', async () => {
    const { useProcesses } = await import('./useProcesses.js');
    const TestComponent = defineComponent({
      setup() {
        const result = useProcesses();
        return result;
      },
      template: '<div/>',
    });
    const w = mount(TestComponent);
    const { processes, loading, error, refresh } = w.vm as any;
    expect(typeof refresh).toBe('function');
    expect(Array.isArray(processes)).toBe(true);
    expect(typeof loading).toBe('boolean');
    expect(error).toBeNull();
    w.unmount();
  });

  it('calls list_processes on first use', async () => {
    const { useExecute } = (await import('./useExecute.js')) as any;
    const executeMock = vi.fn().mockResolvedValue([]);
    useExecute.mockReturnValue({ execute: executeMock });

    const { useProcesses } = await import('./useProcesses.js');
    const TestComponent = defineComponent({
      setup() {
        return useProcesses();
      },
      template: '<div/>',
    });
    const w = mount(TestComponent);
    // Wait for async refresh
    await new Promise((r) => setTimeout(r, 0));
    expect(executeMock).toHaveBeenCalledWith('list_processes', { status: 'all' });
    w.unmount();
  });

  it('populates processes from execute result', async () => {
    const { useExecute } = (await import('./useExecute.js')) as any;
    const fakeProcesses = [
      {
        id: 'proc-1',
        command: 'sleep',
        args: ['10'],
        cwd: '/tmp',
        tty: false,
        shell: false,
        startedAt: '2026-01-01T00:00:00Z',
        startedByParticipantId: 'op',
        pid: 1234,
        status: 'running',
        exitCode: null,
        exitedAt: null,
      },
    ];
    useExecute.mockReturnValue({ execute: vi.fn().mockResolvedValue(fakeProcesses) });

    const { useProcesses } = await import('./useProcesses.js');
    const TestComponent = defineComponent({
      setup() {
        return useProcesses();
      },
      template: '<div/>',
    });
    const w = mount(TestComponent);
    await new Promise((r) => setTimeout(r, 0));
    expect((w.vm as any).processes).toHaveLength(1);
    expect((w.vm as any).processes[0].id).toBe('proc-1');
    w.unmount();
  });

  it('clears poll interval when last consumer unmounts', async () => {
    vi.useFakeTimers();
    const { useExecute } = (await import('./useExecute.js')) as any;
    const executeMock = vi.fn().mockResolvedValue([]);
    useExecute.mockReturnValue({ execute: executeMock });

    const { useProcesses } = await import('./useProcesses.js');
    const TestComponent = defineComponent({
      setup() {
        return useProcesses();
      },
      template: '<div/>',
    });
    const w = mount(TestComponent);
    await vi.runAllTicks();
    const callsAtMount = executeMock.mock.calls.length;

    w.unmount();
    // After unmount, advancing 10s should NOT trigger additional calls
    await vi.advanceTimersByTimeAsync(10_000);
    expect(executeMock.mock.calls.length).toBe(callsAtMount);

    vi.useRealTimers();
  });

  it('refresh() re-fetches and updates processes', async () => {
    const { useExecute } = (await import('./useExecute.js')) as any;
    const executeMock = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 'proc-2',
          command: 'echo',
          args: [],
          cwd: '/tmp',
          tty: false,
          shell: false,
          startedAt: '2026-01-01T00:00:00Z',
          startedByParticipantId: 'op',
          pid: 999,
          status: 'exited',
          exitCode: 0,
          exitedAt: '2026-01-01T00:00:01Z',
        },
      ]);
    useExecute.mockReturnValue({ execute: executeMock });

    const { useProcesses } = await import('./useProcesses.js');
    const TestComponent = defineComponent({
      setup() {
        return useProcesses();
      },
      template: '<div/>',
    });
    const w = mount(TestComponent);
    await new Promise((r) => setTimeout(r, 0));
    expect((w.vm as any).processes).toHaveLength(0);

    await (w.vm as any).refresh();
    expect((w.vm as any).processes).toHaveLength(1);
    expect((w.vm as any).processes[0].id).toBe('proc-2');
    w.unmount();
  });
});
