import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ProviderSlideOver from './ProviderSlideOver.vue';

const execute = vi.fn();
vi.mock('../../composables/useExecute.js', () => ({ useExecute: () => ({ execute }) }));

async function openForm() {
  const wrapper = mount(ProviderSlideOver, {
    global: { stubs: { teleport: true } },
    props: { open: false, provider: null },
  });
  await wrapper.setProps({ open: true });
  return wrapper;
}

describe('ProviderSlideOver provider types', () => {
  beforeEach(() => vi.clearAllMocks());

  it('offers openai-responses in the type dropdown', async () => {
    const wrapper = await openForm();
    const options = wrapper.findAll('select option').map((o) => o.text());
    expect(options).toContain('openai-responses');
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
});
