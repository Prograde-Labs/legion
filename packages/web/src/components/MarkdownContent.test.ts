import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MarkdownContent from './MarkdownContent.vue';

vi.mock('../lib/markdown.js', () => ({
  ensureReady: () => Promise.resolve(),
  render: () => '<div class="code-block"><pre>console.log(1)</pre><button type="button" data-copy-code>Copy</button></div>',
}));

describe('MarkdownContent', () => {
  beforeEach(() => {
    vi.useRealTimers();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    });
  });

  it('does not throw when clipboard is unavailable', () => {
    const wrapper = mount(MarkdownContent, { props: { content: '```js\nconsole.log(1)\n```' } });
    const button = wrapper.find('[data-copy-code]');

    expect(() => {
      button.element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }).not.toThrow();
    expect(button.text()).toBe('Copy');
  });

  it('does not throw when clipboard writeText throws synchronously', () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => { throw new Error('clipboard unavailable'); } },
    });
    const wrapper = mount(MarkdownContent, { props: { content: '```js\nconsole.log(1)\n```' } });
    const button = wrapper.find('[data-copy-code]');

    expect(() => {
      button.element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }).not.toThrow();
    expect(button.text()).toBe('Copy');
  });

  it('keeps the copied state visible for two seconds after the latest click', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const wrapper = mount(MarkdownContent, { props: { content: '```js\nconsole.log(1)\n```' } });
    const button = wrapper.find('[data-copy-code]');

    button.element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
    vi.advanceTimersByTime(1000);
    button.element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
    vi.advanceTimersByTime(1000);

    expect(button.text()).toBe('Copied!');

    vi.advanceTimersByTime(1000);

    expect(button.text()).toBe('Copy');
  });
});
