import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import MarkdownContent from '../MarkdownContent.vue';
import ReasoningDisclosure from './ReasoningDisclosure.vue';

const global = {
  stubs: {
    MarkdownContent: {
      name: 'MarkdownContent',
      props: ['content'],
      template: '<div data-markdown-content>{{ content }}</div>',
    },
  },
};

describe('ReasoningDisclosure', () => {
  it('renders persisted reasoning collapsed through MarkdownContent', () => {
    const wrapper = mount(ReasoningDisclosure, {
      props: { content: '**analysis**', streaming: false },
      global,
    });

    const details = wrapper.get('details[data-reasoning]');
    expect(details.attributes('open')).toBeUndefined();
    expect(details.get('summary').text()).toBe('Reasoning');
    expect(wrapper.getComponent(MarkdownContent).props('content')).toBe('**analysis**');
  });

  it('renders live reasoning forced open without details', () => {
    const wrapper = mount(ReasoningDisclosure, {
      props: { content: 'live thought', streaming: true },
      global,
    });

    expect(wrapper.find('details').exists()).toBe(false);
    expect(wrapper.get('[data-streaming-reasoning]').text()).toContain('Reasoning');
    expect(wrapper.getComponent(MarkdownContent).props('content')).toBe('live thought');
  });
});
