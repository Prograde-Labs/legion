import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProviderSlideOver from './ProviderSlideOver.vue';

const execute = vi.hoisted(() => vi.fn());
vi.mock('../../composables/useLegionApi.js', () => ({ useLegionApi: () => ({ execute }) }));
enableAutoUnmount(afterEach);

async function openForm() {
  const wrapper = mount(ProviderSlideOver, {
    global: { stubs: { teleport: true } },
    props: { open: false, provider: null },
  });
  await wrapper.setProps({ open: true });
  return wrapper;
}

async function openCodexForm() {
  const wrapper = mount(ProviderSlideOver, {
    global: { stubs: { teleport: true } },
    props: {
      open: false,
      provider: { name: 'Codex', type: 'codex', priority: 10 },
    },
  });
  await wrapper.setProps({ open: true });
  return wrapper;
}

describe('ProviderSlideOver codex', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(['Other Codex', 'Codex'])(
    'ignores old auth after reopening the panel for %s',
    async (nextName) => {
      let finishAuth!: (value: unknown) => void;
      const oldAuth = new Promise((resolve) => {
        finishAuth = resolve;
      });
      let reopened = false;
      const usageProviders: unknown[] = [];
      execute.mockImplementation(async (tool: string, args: { providerName: string }) => {
        if (tool === 'openai_auth_status') {
          if (!reopened) return oldAuth;
          return { signedIn: true, email: 'b@example.com', plan: 'plus' };
        }
        if (tool === 'openai_usage') {
          usageProviders.push(args.providerName);
          return { planType: 'plus', windows: [], capturedAt: '2026-11-17T05:00:00.000Z' };
        }
        throw new Error(`unexpected tool ${tool}`);
      });
      const wrapper = await openCodexForm();
      await flushPromises();
      await wrapper.setProps({ open: false });
      reopened = true;
      await wrapper.setProps({
        open: true,
        provider: { name: nextName, type: 'codex', priority: 10 },
      });
      await flushPromises();
      expect(wrapper.get('[data-test="codex-account"]').text()).toContain('b@example.com');
      const usageCount = usageProviders.length;
      finishAuth({ signedIn: true, email: 'a@example.com', plan: 'pro' });
      await flushPromises();
      expect(wrapper.get('[data-test="codex-account"]').text()).toContain('b@example.com');
      expect(wrapper.text()).not.toContain('a@example.com');
      expect(usageProviders).toEqual(Array(usageCount).fill(nextName));
    },
  );

  it.each(['success', 'error'])(
    'ignores stale usage %s after opening another provider',
    async (outcome) => {
      let finishUsage!: (value: unknown) => void;
      let failUsage!: (reason: Error) => void;
      const oldUsage = new Promise((resolve, reject) => {
        finishUsage = resolve;
        failUsage = reject;
      });
      execute.mockImplementation(async (tool: string, args: { providerName: string }) => {
        if (tool === 'openai_auth_status') {
          return { signedIn: true, email: `${args.providerName}@example.com`, plan: 'plus' };
        }
        if (tool === 'openai_usage') {
          if (args.providerName === 'Codex') return oldUsage;
          return {
            planType: 'plus',
            windows: [
              {
                label: '5-hour',
                usedPercent: 12,
                remainingPercent: 88,
                windowSeconds: 18000,
                resetAt: null,
              },
            ],
            capturedAt: '2026-11-17T05:00:00.000Z',
          };
        }
        throw new Error(`unexpected tool ${tool}`);
      });
      const wrapper = await openCodexForm();
      await flushPromises();
      await wrapper.setProps({ open: false });
      await wrapper.setProps({
        open: true,
        provider: { name: 'Other Codex', type: 'codex', priority: 10 },
      });
      await flushPromises();
      expect(wrapper.get('[data-test="codex-usage-window"]').text()).toContain('88% remaining');
      if (outcome === 'success') {
        finishUsage({ planType: 'pro', windows: [], capturedAt: '2026-11-17T05:00:00.000Z' });
      } else {
        failUsage(new Error('old provider usage failed'));
      }
      await flushPromises();
      expect(wrapper.get('[data-test="codex-usage-window"]').text()).toContain('88% remaining');
      expect(wrapper.find('[data-test="codex-usage-error"]').exists()).toBe(false);
    },
  );

  it('shows the device code when re-signing in an existing account', async () => {
    execute.mockImplementation(async (tool: string) => {
      if (tool === 'openai_auth_status') {
        return { signedIn: true, email: 'user@example.com', plan: 'plus' };
      }
      if (tool === 'openai_usage') {
        return { planType: 'plus', windows: [], capturedAt: '2026-11-17T05:00:00.000Z' };
      }
      if (tool === 'openai_login_start') {
        return {
          flowId: 'flow-1',
          providerName: 'Codex',
          verificationUrl: 'https://auth.openai.com/codex/device',
          userCode: 'CODE-1',
          intervalSeconds: 5,
          expiresAt: '2026-11-17T06:00:00.000Z',
        };
      }
      throw new Error(`unexpected tool ${tool}`);
    });
    const wrapper = await openCodexForm();
    await flushPromises();
    await wrapper.get('[data-test="codex-re-sign-in"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-test="codex-user-code"]').text()).toBe('CODE-1');
  });

  it('honors the pending poll interval and stops polling when closed', async () => {
    vi.useFakeTimers();
    let polls = 0;
    try {
      execute.mockImplementation(async (tool: string) => {
        if (tool === 'openai_auth_status') return { signedIn: false };
        if (tool === 'openai_login_start') {
          return {
            flowId: 'flow-1',
            providerName: 'Codex',
            verificationUrl: 'https://auth.openai.com/codex/device',
            userCode: 'CODE-1',
            intervalSeconds: 5,
            expiresAt: '2026-11-17T06:00:00.000Z',
          };
        }
        if (tool === 'openai_login_poll') {
          polls++;
          return { status: 'pending', intervalSeconds: 10 };
        }
        throw new Error(`unexpected tool ${tool}`);
      });
      const wrapper = await openCodexForm();
      await flushPromises();
      await wrapper.get('[data-test="codex-sign-in"]').trigger('click');
      await flushPromises();
      await vi.advanceTimersByTimeAsync(5000);
      expect(polls).toBe(1);
      await vi.advanceTimersByTimeAsync(9999);
      expect(polls).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(polls).toBe(2);
      await wrapper.setProps({ open: false });
      await vi.advanceTimersByTimeAsync(20000);
      expect(polls).toBe(2);
      wrapper.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('hides base URL and API key for codex', async () => {
    const wrapper = await openForm();
    await wrapper.find('[data-test="provider-name"]').setValue('Codex');
    await wrapper.get('select').setValue('codex');

    expect(wrapper.find('[data-test="provider-base-url"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="provider-api-key"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="codex-panel"]').exists()).toBe(true);
  });

  it.each(['close', 'unmount', 'change type'])(
    'does not restart polling after %s while a poll is in flight',
    async (action) => {
      vi.useFakeTimers();
      let finishPoll!: (result: unknown) => void;
      let polls = 0;
      try {
        execute.mockImplementation(async (tool: string) => {
          if (tool === 'openai_auth_status') return { signedIn: false };
          if (tool === 'openai_login_start') {
            return {
              flowId: 'flow-1',
              providerName: 'Codex',
              verificationUrl: 'https://auth.openai.com/codex/device',
              userCode: 'CODE-1',
              intervalSeconds: 5,
              expiresAt: '2026-11-17T06:00:00.000Z',
            };
          }
          if (tool === 'openai_login_poll') {
            polls++;
            return new Promise((resolve) => {
              finishPoll = resolve;
            });
          }
          throw new Error(`unexpected tool ${tool}`);
        });
        const wrapper = await openCodexForm();
        await flushPromises();
        await wrapper.get('[data-test="codex-sign-in"]').trigger('click');
        await flushPromises();
        await vi.advanceTimersByTimeAsync(5000);
        expect(polls).toBe(1);
        if (action === 'close') await wrapper.setProps({ open: false });
        else if (action === 'unmount') wrapper.unmount();
        else await wrapper.get('select').setValue('openai-compatible');
        finishPoll({ status: 'pending', intervalSeconds: 5 });
        await flushPromises();
        await vi.advanceTimersByTimeAsync(10000);
        expect(polls).toBe(1);
        expect(wrapper.emitted('saved')).toBeUndefined();
        wrapper.unmount();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('ignores a login-start response after closing and reopening', async () => {
    let finishStart!: (result: unknown) => void;
    execute.mockImplementation(async (tool: string) => {
      if (tool === 'openai_auth_status') return { signedIn: false };
      if (tool === 'openai_login_start') {
        return new Promise((resolve) => {
          finishStart = resolve;
        });
      }
      throw new Error(`unexpected tool ${tool}`);
    });
    const wrapper = await openCodexForm();
    await flushPromises();
    await wrapper.get('[data-test="codex-sign-in"]').trigger('click');
    await wrapper.setProps({ open: false });
    await wrapper.setProps({ open: true });
    finishStart({
      flowId: 'flow-1',
      providerName: 'Codex',
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'CODE-1',
      intervalSeconds: 5,
      expiresAt: '2026-11-17T06:00:00.000Z',
    });
    await flushPromises();
    expect(wrapper.find('[data-test="codex-user-code"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="codex-sign-in"]').exists()).toBe(true);
  });

  it('shows the verification URL and code after starting a login', async () => {
    execute.mockImplementation(async (tool: string) => {
      if (tool === 'openai_auth_status') return { signedIn: false };
      if (tool === 'openai_login_start') {
        return {
          flowId: 'flow-1',
          providerName: 'Codex',
          verificationUrl: 'https://auth.openai.com/codex/device',
          userCode: 'CODE-1',
          intervalSeconds: 5,
          expiresAt: '2026-11-17T06:00:00.000Z',
        };
      }
      throw new Error(`unexpected tool ${tool}`);
    });

    const wrapper = await openCodexForm();
    await vi.waitFor(() => expect(wrapper.find('[data-test="codex-sign-in"]').exists()).toBe(true));
    await wrapper.find('[data-test="codex-sign-in"]').trigger('click');

    await vi.waitFor(() =>
      expect(wrapper.find('[data-test="codex-user-code"]').text()).toContain('CODE-1'),
    );
    expect(wrapper.find('[data-test="codex-verification-url"]').text()).toContain(
      'https://auth.openai.com/codex/device',
    );
    expect(wrapper.text()).toContain('Waiting for approval');
  });

  it('polls to completion and emits saved', async () => {
    vi.useFakeTimers();
    try {
      execute.mockImplementation(async (tool: string) => {
        if (tool === 'openai_auth_status') return { signedIn: false };
        if (tool === 'openai_login_start') {
          return {
            flowId: 'flow-1',
            providerName: 'Codex',
            verificationUrl: 'https://auth.openai.com/codex/device',
            userCode: 'CODE-1',
            intervalSeconds: 5,
            expiresAt: '2026-11-17T06:00:00.000Z',
          };
        }
        if (tool === 'openai_login_poll') {
          return {
            status: 'complete',
            providerName: 'Codex',
            priority: 10,
            account: { email: 'user@example.com', plan: 'plus' },
          };
        }
        if (tool === 'openai_usage') {
          return { planType: 'plus', windows: [], capturedAt: '2026-11-17T05:00:00.000Z' };
        }
        throw new Error(`unexpected tool ${tool}`);
      });

      const wrapper = await openCodexForm();
      await flushPromises();
      await wrapper.find('[data-test="codex-sign-in"]').trigger('click');
      await flushPromises();
      await vi.advanceTimersByTimeAsync(5000);
      await flushPromises();

      expect(wrapper.emitted('saved')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders the signed-in account and usage windows', async () => {
    execute.mockImplementation(async (tool: string) => {
      if (tool === 'openai_auth_status') {
        return { signedIn: true, email: 'user@example.com', plan: 'plus' };
      }
      if (tool === 'openai_usage') {
        return {
          planType: 'plus',
          windows: [
            {
              label: '5-hour',
              usedPercent: 12,
              remainingPercent: 88,
              windowSeconds: 18000,
              resetAt: null,
            },
          ],
          capturedAt: '2026-11-17T05:00:00.000Z',
        };
      }
      throw new Error(`unexpected tool ${tool}`);
    });

    const wrapper = await openCodexForm();
    await vi.waitFor(() =>
      expect(wrapper.find('[data-test="codex-account"]').text()).toContain('user@example.com'),
    );
    expect(wrapper.find('[data-test="codex-account"]').text()).toContain('plus');
    expect(wrapper.find('[data-test="codex-usage-window"]').text()).toContain('88% remaining');
  });

  it('signs out and emits saved', async () => {
    execute.mockImplementation(async (tool: string) => {
      if (tool === 'openai_auth_status') {
        return { signedIn: true, email: 'user@example.com', plan: 'plus' };
      }
      if (tool === 'openai_usage') {
        return { planType: 'plus', windows: [], capturedAt: '2026-11-17T05:00:00.000Z' };
      }
      if (tool === 'openai_logout') return { signedOut: true, revoked: true };
      throw new Error(`unexpected tool ${tool}`);
    });

    const wrapper = await openCodexForm();
    await vi.waitFor(() =>
      expect(wrapper.find('[data-test="codex-sign-out"]').exists()).toBe(true),
    );
    await wrapper.find('[data-test="codex-sign-out"]').trigger('click');

    await vi.waitFor(() => expect(wrapper.find('[data-test="codex-sign-in"]').exists()).toBe(true));
    expect(wrapper.emitted('saved')).toBeTruthy();
  });
});

describe('ProviderSlideOver provider types', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('offers openai-responses in the type dropdown', async () => {
    const wrapper = await openForm();
    const options = wrapper.findAll('select option').map((o) => o.text());
    expect(options).toContain('openai-responses');
  });

  it('offers the constructible provider types including codex', async () => {
    const wrapper = await openForm();
    const values = wrapper
      .findAll('select option')
      .map((o) => (o.element as HTMLOptionElement).value);
    expect(values).toEqual(['openai-compatible', 'openai-responses', 'codex']);
  });

  it('shows the base URL field for openai-responses', async () => {
    const wrapper = await openForm();
    const select = wrapper.get('select');
    await select.setValue('openai-responses');
    expect(wrapper.text()).toContain('Base URL');
  });

  it('shows an error banner when save fails', async () => {
    execute.mockRejectedValueOnce(new Error('save failed'));
    const wrapper = await openForm();
    await wrapper.find('[data-test="provider-name"]').setValue('local');
    await wrapper.find('[data-test="provider-save"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.find('[data-test="provider-error"]').text()).toContain('save failed'),
    );
  });

  it('clears the error banner when the slide-over reopens', async () => {
    execute.mockRejectedValueOnce(new Error('save failed'));
    const wrapper = await openForm();
    await wrapper.find('[data-test="provider-name"]').setValue('local');
    await wrapper.find('[data-test="provider-save"]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.find('[data-test="provider-error"]').exists()).toBe(true),
    );
    await wrapper.setProps({ open: false });
    await wrapper.setProps({ open: true });
    expect(wrapper.find('[data-test="provider-error"]').exists()).toBe(false);
  });
});
