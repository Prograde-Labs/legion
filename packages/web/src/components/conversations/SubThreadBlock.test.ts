import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import SubThreadBlock from './SubThreadBlock.vue';

describe('SubThreadBlock', () => {
  it('renders a flat message list', () => {
    const messages = [
      {
        id: 'm1',
        author: 'agent-1',
        authorColour: '#22d3ee',
        content: 'Hello',
        timestamp: '12:00',
        toolCalls: [],
      },
    ];
    const w = mount(SubThreadBlock, { props: { messages } });
    expect(w.text()).toContain('Hello');
    expect(w.text()).toContain('agent-1');
  });

  it('renders nested delegation tool call', () => {
    const messages = [
      {
        id: 'm1',
        author: 'orchestrator',
        authorColour: '#22d3ee',
        content: 'Delegating',
        timestamp: '12:00',
        toolCalls: [
          {
            id: 'tc1',
            tool: 'send_message',
            type: 'delegation' as const,
            timestamp: '12:00',
            subThread: [
              {
                id: 'm2',
                author: 'researcher',
                authorColour: '#f59e0b',
                content: 'Sub-response',
                timestamp: '12:01',
                toolCalls: [],
              },
            ],
          },
        ],
      },
    ];
    const w = mount(SubThreadBlock, { props: { messages }, global: { stubs: { teleport: true } } });
    expect(w.text()).toContain('Delegating');
  });
});
