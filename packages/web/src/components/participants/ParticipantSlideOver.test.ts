import { mount, flushPromises } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ParticipantSlideOver from './ParticipantSlideOver.vue';
import type { MiddlewareDefinitionInfo } from './middleware-ui-types.js';

const execute = vi.fn();
vi.mock('../../composables/useExecute.js', () => ({ useExecute: () => ({ execute }) }));

const definitions: MiddlewareDefinitionInfo[] = [
  {
    type: 'builtin:skills',
    displayName: 'Skills',
    defaultFailureMode: 'closed' as const,
    configSchema: { type: 'object', properties: {} },
    source: 'builtin',
  },
];

describe('ParticipantSlideOver middleware', () => {
  beforeEach(() => vi.clearAllMocks());

  it('loads participant middleware and replaces its ordered configuration', async () => {
    execute.mockResolvedValueOnce({
      name: 'Agent',
      model: { model: 'm' },
      tools: {},
      middlewareRevision: 4,
      middleware: [{ id: 'skills-1', type: 'builtin:skills', config: { skills: ['alpha'] } }],
    });
    const wrapper = mount(ParticipantSlideOver, {
      global: { stubs: { teleport: true } },
      props: {
        open: false,
        participantId: 'agent-1',
        availableTools: [],
        availableModels: [],
        middlewareDefinitions: definitions,
        middlewareDiagnostics: [],
        skills: [],
        credentialKeys: [],
      },
    });
    await wrapper.setProps({ open: true });
    await flushPromises();
    await wrapper.get('[data-tab="middleware"]').trigger('click');
    expect(wrapper.text()).toContain('skills-1');
    await wrapper.get('[data-save-participant]').trigger('click');
    await flushPromises();
    expect(execute).toHaveBeenCalledWith('set_participant_middleware', {
      participantId: 'agent-1',
      middleware: [{ id: 'skills-1', type: 'builtin:skills', config: { skills: ['alpha'] } }],
    });
  });

  it('includes middleware directly in create_agent', async () => {
    execute.mockResolvedValueOnce({ id: 'new-agent' });
    const wrapper = mount(ParticipantSlideOver, {
      global: { stubs: { teleport: true } },
      props: {
        open: false,
        participantId: null,
        availableTools: [],
        availableModels: [],
        middlewareDefinitions: definitions,
        middlewareDiagnostics: [],
        skills: [],
        credentialKeys: [],
      },
    });
    await wrapper.setProps({ open: true });
    await flushPromises();
    await wrapper.get('[data-tab="middleware"]').trigger('click');
    await wrapper.get('select').setValue('builtin:skills');
    const addButton = wrapper.findAll('button').find((button) => button.text() === 'Add');
    if (!addButton) throw new Error('Add middleware button not found');
    await addButton.trigger('click');
    await wrapper.get('[data-tab="basic"]').trigger('click');
    await wrapper.get('input').setValue('New Agent');
    await wrapper.get('[data-save-participant]').trigger('click');
    expect(execute).toHaveBeenCalledWith(
      'create_agent',
      expect.objectContaining({
        middleware: [{ id: 'builtin-skills-1', type: 'builtin:skills', config: {} }],
      }),
    );
  });
});
