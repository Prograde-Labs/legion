import { mount } from '@vue/test-utils';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { nextTick } from 'vue';

const executeMock = vi.fn();
vi.mock('../../composables/useExecute.js', () => ({
  useExecute: () => ({ execute: executeMock }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

describe('ProcessStartForm', () => {
  it('renders a command input', async () => {
    const { default: ProcessStartForm } = await import('./ProcessStartForm.vue');
    const w = mount(ProcessStartForm);
    expect(w.find('input[placeholder*="command"]').exists()).toBe(true);
  });

  it('submit button is disabled when command is empty', async () => {
    const { default: ProcessStartForm } = await import('./ProcessStartForm.vue');
    const w = mount(ProcessStartForm);
    const btn = w.find('button[type="submit"]');
    expect(btn.attributes('disabled')).toBeDefined();
  });

  it('submit button is enabled when command is filled', async () => {
    const { default: ProcessStartForm } = await import('./ProcessStartForm.vue');
    const w = mount(ProcessStartForm);
    await w.find('input[placeholder*="command"]').setValue('npm');
    await nextTick();
    const btn = w.find('button[type="submit"]');
    expect(btn.attributes('disabled')).toBeUndefined();
  });

  it('calls start_process with correct args on submit', async () => {
    const { default: ProcessStartForm } = await import('./ProcessStartForm.vue');
    executeMock.mockResolvedValue({
      id: 'proc-new',
      status: 'running',
      command: 'npm',
      args: ['run', 'dev'],
      cwd: '/tmp',
      tty: false,
      shell: false,
      startedAt: '2026-01-01T00:00:00Z',
      startedByParticipantId: 'op',
      pid: 1,
      exitCode: null,
      exitedAt: null,
    });

    const w = mount(ProcessStartForm);
    await w.find('input[placeholder*="command"]').setValue('npm');
    await w.find('input[placeholder*="args"]').setValue('run dev');
    await nextTick();
    await w.find('button[type="submit"]').trigger('click');
    await new Promise((r) => setTimeout(r, 0));

    expect(executeMock).toHaveBeenCalledWith(
      'start_process',
      expect.objectContaining({
        command: 'npm',
        args: ['run', 'dev'],
      }),
    );
  });

  it('emits started event with process id on success', async () => {
    const { default: ProcessStartForm } = await import('./ProcessStartForm.vue');
    executeMock.mockResolvedValue({
      id: 'proc-new',
      status: 'running',
      command: 'echo',
      args: [],
      cwd: '/tmp',
      tty: false,
      shell: false,
      startedAt: '2026-01-01T00:00:00Z',
      startedByParticipantId: 'op',
      pid: 1,
      exitCode: null,
      exitedAt: null,
    });

    const w = mount(ProcessStartForm);
    await w.find('input[placeholder*="command"]').setValue('echo');
    await nextTick();
    await w.find('button[type="submit"]').trigger('click');
    await new Promise((r) => setTimeout(r, 0));

    expect(w.emitted('started')).toBeTruthy();
    expect(w.emitted('started')![0]).toEqual(['proc-new']);
  });

  it('shows inline error and keeps form open on failure', async () => {
    const { default: ProcessStartForm } = await import('./ProcessStartForm.vue');
    executeMock.mockRejectedValue(new Error('spawn ENOENT'));

    const w = mount(ProcessStartForm);
    await w.find('input[placeholder*="command"]').setValue('does-not-exist');
    await nextTick();
    await w.find('button[type="submit"]').trigger('click');
    await new Promise((r) => setTimeout(r, 0));
    await nextTick();

    expect(w.text()).toContain('spawn ENOENT');
    // Form still present
    expect(w.find('input[placeholder*="command"]').exists()).toBe(true);
  });

  it('splits args string on spaces', async () => {
    const { default: ProcessStartForm } = await import('./ProcessStartForm.vue');
    executeMock.mockResolvedValue({
      id: 'proc-x',
      status: 'running',
      command: 'npm',
      args: ['run', 'build'],
      cwd: '/tmp',
      tty: false,
      shell: false,
      startedAt: '2026-01-01T00:00:00Z',
      startedByParticipantId: 'op',
      pid: 2,
      exitCode: null,
      exitedAt: null,
    });

    const w = mount(ProcessStartForm);
    await w.find('input[placeholder*="command"]').setValue('npm');
    await w.find('input[placeholder*="args"]').setValue('run  build'); // extra space
    await nextTick();
    await w.find('button[type="submit"]').trigger('click');
    await new Promise((r) => setTimeout(r, 0));

    expect(executeMock).toHaveBeenCalledWith(
      'start_process',
      expect.objectContaining({
        args: ['run', 'build'], // extra space stripped
      }),
    );
  });
});
