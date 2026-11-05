import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ProviderSlideOver from './ProviderSlideOver.vue';

const execute = vi.hoisted(() => vi.fn());
vi.mock('../../composables/useLegionApi.js', () => ({ useLegionApi: () => ({ execute }) }));

async function openForm() {
  const wrapper = mount(ProviderSlideOver, {
    global: { stubs: { teleport: true } },
    props: { open: false, provider: null },
  });
  await wrapper.setProps({ open: true });
  return wrapper;
}

describe('ProviderSlideOver provider types', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('offers openai-responses in the type dropdown', async () => {
    const wrapper = await openForm();
    const options = wrapper.findAll('select option').map((o) => o.text());
    expect(options).toContain('openai-responses');
  });

  it('disables provider types the store cannot construct', async () => {
    const wrapper = await openForm();
    const options = wrapper.findAll('select option');
    const byValue = (value: string) =>
      options.find((o) => (o.element as HTMLOptionElement).value === value);

    expect((byValue('anthropic')?.element as HTMLOptionElement).disabled).toBe(true);
    expect((byValue('copilot')?.element as HTMLOptionElement).disabled).toBe(true);
    expect((byValue('codex')?.element as HTMLOptionElement).disabled).toBe(true);
    expect((byValue('openai-responses')?.element as HTMLOptionElement).disabled).toBe(false);
  });

  it('shows the base URL field for openai-responses', async () => {
    const wrapper = await openForm();
    const select = wrapper.get('select');
    await select.setValue('openai-responses');
    expect(wrapper.text()).toContain('Base URL');
  });

  it('hides the base URL field for anthropic (existing behavior)', async () => {
    const wrapper = await openForm();
    const select = wrapper.get('select');
    await select.setValue('anthropic');
    expect(wrapper.text()).not.toContain('Base URL');
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
