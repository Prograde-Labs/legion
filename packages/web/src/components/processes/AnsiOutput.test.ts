import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

// Mock ansi_up — pass-through with light ANSI stripping for test clarity
vi.mock('ansi_up', () => ({
  AnsiUp: class {
    ansi_to_html(text: string): string {
      // Strip ANSI escape codes, return plain text (sufficient for tests)
      return text.replace(/\x1b\[[0-9;]*m/g, '');
    }
  },
}));

describe('AnsiOutput', () => {
  it('renders a pre element', async () => {
    const { default: AnsiOutput } = await import('./AnsiOutput.vue');
    const w = mount(AnsiOutput, { props: { chunks: [] } });
    expect(w.find('pre').exists()).toBe(true);
  });

  it('renders initial chunks on mount', async () => {
    const { default: AnsiOutput } = await import('./AnsiOutput.vue');
    const w = mount(AnsiOutput, { props: { chunks: ['hello world'] } });
    await nextTick();
    expect(w.find('pre').html()).toContain('hello world');
  });

  it('appends newly added chunks without re-processing old ones', async () => {
    const { default: AnsiOutput } = await import('./AnsiOutput.vue');
    const w = mount(AnsiOutput, { props: { chunks: ['first '] } });
    await nextTick();
    await w.setProps({ chunks: ['first ', 'second'] });
    await nextTick();
    const html = w.find('pre').html();
    expect(html).toContain('first');
    expect(html).toContain('second');
  });

  it('does not re-process existing chunks when new ones are added', async () => {
    let callCount = 0;
    vi.doMock('ansi_up', () => ({
      AnsiUp: class {
        ansi_to_html(text: string): string {
          callCount++;
          return text;
        }
      },
    }));

    // Use fresh module to pick up updated mock
    vi.resetModules();
    const { default: AnsiOutput } = await import('./AnsiOutput.vue');
    const w = mount(AnsiOutput, { props: { chunks: ['a'] } });
    await nextTick();
    const callsAfterFirst = callCount;

    await w.setProps({ chunks: ['a', 'b'] });
    await nextTick();

    // Only one new call for 'b', not a re-process of 'a'
    expect(callCount - callsAfterFirst).toBe(1);

    vi.doUnmock('ansi_up');
    vi.resetModules();
  });

  it('renders empty pre when no chunks provided', async () => {
    const { default: AnsiOutput } = await import('./AnsiOutput.vue');
    const w = mount(AnsiOutput, { props: { chunks: [] } });
    await nextTick();
    // pre exists and has no meaningful content
    expect(w.find('pre').exists()).toBe(true);
  });
});
