import { describe, expect, it, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import ParticipantsList from './ParticipantsList.vue';
import { useParticipants } from '../composables/useParticipants.js';
import { useToolAccess } from '../composables/useToolAccess.js';

vi.mock('../composables/useToolAccess.js', () => ({ useToolAccess: vi.fn() }));

function mockCan(can: (tool: string) => 'auto' | 'requires_approval' | 'hidden'): void {
  vi.mocked(useToolAccess).mockReturnValue({ can } as never);
}

const PARTICIPANTS = [
  {
    id: 'agent-a',
    name: 'Agent A',
    type: 'agent',
    status: 'active',
    tools: {},
    model: { model: 'gpt-4o' },
    systemPrompt: 'x',
    maxIterations: 20,
  },
  { id: 'svc', name: 'Scheduler', type: 'service', status: 'active', tools: {}, module: 'cron' },
  {
    id: 'operator',
    name: 'Operator',
    type: 'user',
    status: 'active',
    tools: {},
    operator: true,
    protected: true,
  },
];

describe('ParticipantsList', () => {
  beforeEach(() => {
    mockCan(() => 'auto');
    // seed via the composable's test helper (SFC files cannot export helpers)
    useParticipants().__setParticipantsForTests(PARTICIPANTS as never);
  });

  it('renders rows with type badges and status', () => {
    const wrapper = mount(ParticipantsList);
    const rows = wrapper.findAll('[data-test="participant-row"]');
    expect(rows.length).toBe(3);
    expect(rows[0].text()).toContain('Agent A');
    expect(rows[0].find('[data-test="type-badge"]').text()).toBe('agent');
  });

  it('search filters by name', async () => {
    const wrapper = mount(ParticipantsList);
    await wrapper.find('input[type="search"]').setValue('sched');
    expect(wrapper.findAll('[data-test="participant-row"]').length).toBe(1);
  });

  it('emits select with the participant id', async () => {
    const wrapper = mount(ParticipantsList);
    await wrapper.findAll('[data-test="participant-row"]')[0].trigger('click');
    expect(wrapper.emitted('select')?.[0]).toEqual(['agent-a']);
  });

  it('emits create for the new-agent button', async () => {
    const wrapper = mount(ParticipantsList);
    await wrapper.find('[data-test="new-agent"]').trigger('click');
    expect(wrapper.emitted('select')?.[0]).toEqual(['new']);
  });

  it('emits select new-user for the new-user button', async () => {
    const wrapper = mount(ParticipantsList);
    await wrapper.find('[data-test="new-user"]').trigger('click');
    expect(wrapper.emitted('select')?.[0]).toEqual(['new-user']);
  });

  it('hides create affordances without create access', () => {
    mockCan((t) => (t === 'create_agent' || t === 'create_user' ? 'hidden' : 'auto'));
    const wrapper = mount(ParticipantsList);
    expect(wrapper.find('[data-test="new-agent"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="new-user"]').exists()).toBe(false);
    // Read-only rows stay.
    expect(wrapper.findAll('[data-test="participant-row"]').length).toBe(3);
  });

  it('hides only the new-user button when create_user is denied', () => {
    mockCan((t) => (t === 'create_user' ? 'hidden' : 'auto'));
    const wrapper = mount(ParticipantsList);
    expect(wrapper.find('[data-test="new-agent"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="new-user"]').exists()).toBe(false);
  });
});
