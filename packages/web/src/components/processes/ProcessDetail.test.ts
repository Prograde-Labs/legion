import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import ProcessDetail from './ProcessDetail.vue';

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  can: vi.fn(() => 'auto'),
}));

vi.mock('../../composables/useLegionApi.js', () => ({
  useLegionApi: () => ({ execute: mocks.execute }),
}));

vi.mock('../../composables/useToolAccess.js', () => ({
  useToolAccess: () => ({ can: mocks.can }),
}));

vi.mock('../../composables/useToolStream.js', () => ({
  useToolStream: () => ({
    start: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    chunks: { value: [] },
    done: { value: false },
    error: { value: null },
    active: { value: false },
  }),
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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.can.mockReturnValue('auto');
});

describe('ProcessDetail action errors', () => {
  it('shows an error banner when stop fails', async () => {
    mocks.execute.mockImplementation(async (tool: string) => {
      if (tool === 'get_process') return RUNNING_HANDLE;
      if (tool === 'read_process_output') return { data: '', totalBytes: 0, from: 0 };
      if (tool === 'stop_process') throw new Error('stop failed');
      return {};
    });
    const wrapper = mount(ProcessDetail, { props: { processId: 'proc-1' } });
    await vi.waitFor(() => expect(wrapper.find('[data-test="process-stop"]').exists()).toBe(true));
    await wrapper.find('[data-test="process-stop"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.find('[data-test="process-error"]').text()).toContain('stop failed'),
    );
    wrapper.unmount();
  });

  it('shows an error banner when delete fails', async () => {
    mocks.execute.mockImplementation(async (tool: string) => {
      if (tool === 'get_process') return EXITED_HANDLE;
      if (tool === 'read_process_output') return { data: '', totalBytes: 0, from: 0 };
      if (tool === 'delete_process') throw new Error('delete failed');
      return {};
    });
    const wrapper = mount(ProcessDetail, { props: { processId: 'proc-1' } });
    await vi.waitFor(() =>
      expect(wrapper.find('[data-test="process-delete"]').exists()).toBe(true),
    );
    await wrapper.find('[data-test="process-delete"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.find('[data-test="process-error"]').text()).toContain('delete failed'),
    );
    wrapper.unmount();
  });
});
