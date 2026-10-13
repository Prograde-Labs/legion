import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import AgentEditor from './AgentEditor.vue';
import { useToolAccess } from '../composables/useToolAccess.js';

vi.mock('../composables/useToolAccess.js', () => ({ useToolAccess: vi.fn() }));

function mockCan(can: (tool: string) => 'auto' | 'requires_approval' | 'hidden'): void {
  vi.mocked(useToolAccess).mockReturnValue({ can } as never);
}

const AGENT = {
  id: 'agent-a',
  name: 'Agent A',
  type: 'agent',
  status: 'active',
  tools: {},
  model: { model: 'gpt-4o' },
  systemPrompt: 'x',
  maxIterations: 20,
};

function toolResponse(_tool: string, data: unknown): Response {
  return new Response(JSON.stringify({ result: { status: 'success', data } }), { status: 200 });
}

function stubFetch(): ReturnType<typeof vi.fn> {
  return vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (body.tool === 'get_participant') return toolResponse('get_participant', AGENT);
    if (body.tool === 'list_tools')
      return toolResponse('list_tools', { tools: ['communicate', 'file_read'], callerPolicy: {} });
    if (body.tool === 'list_models')
      return toolResponse('list_models', [{ provider: 'openai', model: 'gpt-4o' }]);
    return toolResponse(body.tool, {});
  });
}

function seedToken(): void {
  localStorage.setItem('legion-token', 'tok');
  localStorage.setItem('legion-expires-at', String(Math.floor(Date.now() / 1000) + 3600));
}

describe('AgentEditor', () => {
  beforeEach(() => {
    mockCan(() => 'auto');
    localStorage.clear();
    vi.unstubAllGlobals();
    seedToken();
  });

  it('prefills fields from get_participant', async () => {
    vi.stubGlobal('fetch', stubFetch());
    const wrapper = mount(AgentEditor, { props: { participantId: 'agent-a' } });
    await vi.waitFor(() =>
      expect((wrapper.find('[data-test="agent-name"]').element as HTMLInputElement).value).toBe(
        'Agent A',
      ),
    );
    expect(wrapper.find('[data-test="agent-system-prompt"]').element.textContent).toContain('x');
  });

  it('save on an existing agent calls modify_agent with edited fields', async () => {
    const fetchMock = stubFetch();
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(AgentEditor, { props: { participantId: 'agent-a' } });
    await vi.waitFor(() =>
      expect((wrapper.find('[data-test="agent-name"]').element as HTMLInputElement).value).toBe(
        'Agent A',
      ),
    );
    await wrapper.find('[data-test="agent-name"]').setValue('Renamed');
    await wrapper.find('[data-test="agent-save"]').trigger('click');
    await vi.waitFor(() => {
      const call = fetchMock.mock.calls.find(
        (c) => JSON.parse(String(c[1]?.body)).tool === 'modify_agent',
      );
      expect(call).toBeDefined();
      expect(JSON.parse(String(call![1]?.body)).args.name).toBe('Renamed');
    });
  });

  it('save on new calls create_agent', async () => {
    const fetchMock = stubFetch();
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(AgentEditor, { props: { participantId: 'new' } });
    await wrapper.find('[data-test="agent-name"]').setValue('Fresh Agent');
    await wrapper.find('[data-test="agent-save"]').trigger('click');
    await vi.waitFor(() => {
      const call = fetchMock.mock.calls.find(
        (c) => JSON.parse(String(c[1]?.body)).tool === 'create_agent',
      );
      expect(call).toBeDefined();
    });
  });

  it('save sends middleware via set_participant_middleware (modify_agent has no middleware param)', async () => {
    const fetchMock = stubFetch();
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(AgentEditor, { props: { participantId: 'agent-a' } });
    await vi.waitFor(() =>
      expect((wrapper.find('[data-test="agent-name"]').element as HTMLInputElement).value).toBe(
        'Agent A',
      ),
    );
    await wrapper.find('[data-test="agent-save"]').trigger('click');
    await vi.waitFor(() => {
      const call = fetchMock.mock.calls.find(
        (c) => JSON.parse(String(c[1]?.body)).tool === 'set_participant_middleware',
      );
      expect(call).toBeDefined();
      const args = JSON.parse(String(call![1]?.body)).args;
      expect(args.participantId).toBe('agent-a');
      expect(Array.isArray(args.middleware)).toBe(true);
    });
  });

  it('retire hidden for protected participants', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}'));
        if (body.tool === 'get_participant')
          return toolResponse('get_participant', { ...AGENT, protected: true });
        if (body.tool === 'list_tools')
          return toolResponse('list_tools', { tools: [], callerPolicy: {} });
        if (body.tool === 'list_models') return toolResponse('list_models', []);
        return toolResponse(body.tool, {});
      }),
    );
    const wrapper = mount(AgentEditor, { props: { participantId: 'agent-a' } });
    await vi.waitFor(() => wrapper.find('[data-test="agent-name"]').exists());
    expect(wrapper.find('[data-test="agent-retire"]').exists()).toBe(false);
  });

  it('hides save/retire/authority affordances without the matching tool access', async () => {
    mockCan((t) => (t === 'get_participant' || t === 'list_tools' ? 'auto' : 'hidden'));
    vi.stubGlobal('fetch', stubFetch());
    const wrapper = mount(AgentEditor, { props: { participantId: 'agent-a' } });
    await vi.waitFor(() => wrapper.find('[data-test="agent-name"]').exists());
    expect(wrapper.find('[data-test="agent-save"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="agent-retire"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="authority-save"]').exists()).toBe(false);
  });
});
