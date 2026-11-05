import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import AccountSlideOver from './AccountSlideOver.vue';
import { useTheme } from '../theme/useTheme.js';

const router = createRouter({
  history: createMemoryHistory(),
  routes: [{ path: '/', component: { template: '<div />' } }],
});

function mountOpen() {
  return mount(AccountSlideOver, {
    props: { open: true },
    global: { plugins: [router], stubs: { teleport: true } },
  });
}

describe('AccountSlideOver theme switch', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    useTheme().setTheme('command-deck');
  });

  it('switches the theme and persists it', async () => {
    const wrapper = mountOpen();
    await wrapper.find('[data-test="theme-select"]').setValue('blueprint-light');
    expect(document.documentElement.dataset.theme).toBe('blueprint-light');
    expect(localStorage.getItem('legion-theme')).toBe('blueprint-light');
  });

  it('reflects the current theme in the select', () => {
    useTheme().setTheme('blueprint-light');
    const wrapper = mountOpen();
    const select = wrapper.find('[data-test="theme-select"]');
    expect((select.element as HTMLSelectElement).value).toBe('blueprint-light');
  });
});
