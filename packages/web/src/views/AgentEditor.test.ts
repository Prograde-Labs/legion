import { describe, expect, it, vi, beforeEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
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

// One builtin:skills instance (renders SkillsSelector) and one schema-driven
// instance whose credential field is required (renders credential-key options
// and reports a validation error while empty).
const MIDDLEWARE_DEFINITIONS = [
  {
    type: 'builtin:skills',
    displayName: 'Skills',
    defaultFailureMode: 'open',
    configSchema: {
      type: 'object',
      properties: { skills: { type: 'array', items: { type: 'string' } } },
    },
    source: 'builtin',
  },
  {
    type: 'workspace:telegram',
    displayName: 'Telegram',
    defaultFailureMode: 'closed',
    configSchema: {
      type: 'object',
      properties: {
        botToken: { type: 'string', title: 'Bot token', format: 'credential-reference' },
      },
      required: ['botToken'],
    },
    source: 'workspace',
  },
];

const MIDDLEWARE = [
  { id: 'skills-1', type: 'builtin:skills', config: { skills: [] } },
  { id: 'telegram-1', type: 'workspace:telegram', config: {} },
];

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
      return toolResponse('list_models', [
        { provider: 'openai', model: { id: 'gpt-4o', name: 'GPT-4o' } },
      ]);
    if (body.tool === 'list_middleware')
      return toolResponse('list_middleware', { definitions: [] });
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

  it('hydrates name, system prompt and tool override policies for an existing agent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}'));
        if (body.tool === 'get_participant')
          return toolResponse('get_participant', {
            ...AGENT,
            systemPrompt: 'You are helpful.',
            maxIterations: 25,
            model: { model: 'GLM-5.3-Flash-EXL3' },
            tools: { communicate: 'auto', file_read: 'requires_approval' },
          });
        if (body.tool === 'list_tools')
          return toolResponse('list_tools', {
            tools: ['communicate', 'file_read', 'list_tools'],
            callerPolicy: {},
          });
        if (body.tool === 'list_models')
          return toolResponse('list_models', [
            { provider: 'openai', model: { id: 'gpt-4o', name: 'GPT-4o' } },
          ]);
        if (body.tool === 'list_middleware')
          return toolResponse('list_middleware', { definitions: [] });
        return toolResponse(body.tool, {});
      }),
    );
    const wrapper = mount(AgentEditor, { props: { participantId: 'agent-a' } });
    await vi.waitFor(() =>
      expect((wrapper.find('[data-test="agent-name"]').element as HTMLInputElement).value).toBe(
        'Agent A',
      ),
    );
    expect(
      (wrapper.find('[data-test="agent-system-prompt"]').element as HTMLTextAreaElement).value,
    ).toBe('You are helpful.');
    // Every tool from get_participant's map plus the full list_tools roster renders
    // as an override row; hydrated policies start enabled.
    const rows = wrapper.findAll('[data-tool-row]');
    expect(rows.length).toBeGreaterThanOrEqual(3);
    const checked = rows.filter(
      (r) => (r.find('input[type="checkbox"]').element as HTMLInputElement).checked,
    );
    expect(checked.length).toBe(2);
    expect(rows[1].text()).toContain('file_read');
    expect(rows[1].text()).toContain('require approval');
  });

  it('renders model ids from list_models and saves the selected id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}'));
        if (body.tool === 'get_participant')
          return toolResponse('get_participant', {
            ...AGENT,
            model: { model: 'DeepSeek-V4.1-Flash-1017' },
          });
        if (body.tool === 'list_tools')
          return toolResponse('list_tools', { tools: ['communicate'], callerPolicy: {} });
        if (body.tool === 'list_models')
          return toolResponse('list_models', [
            {
              provider: 'local',
              model: { id: 'DeepSeek-V4.1-Flash-1017', name: 'DeepSeek V4.1 Flash' },
            },
          ]);
        if (body.tool === 'list_middleware')
          return toolResponse('list_middleware', { definitions: [] });
        if (body.tool === 'modify_agent') return toolResponse('modify_agent', { id: 'agent-a' });
        return toolResponse(body.tool, {});
      }),
    );
    const wrapper = mount(AgentEditor, { props: { participantId: 'agent-a' } });
    await vi.waitFor(() =>
      expect((wrapper.find('[data-test="agent-model"]').element as HTMLSelectElement).value).toBe(
        'DeepSeek-V4.1-Flash-1017',
      ),
    );
    const options = wrapper.findAll('[data-test="agent-model"] option');
    expect(options.map((o) => o.attributes('value'))).toContain('DeepSeek-V4.1-Flash-1017');
    await wrapper.find('[data-test="agent-save"]').trigger('click');
    await flushPromises();
    const saveCall = (vi.mocked(fetch).mock.calls as Array<[string, RequestInit]>).find(
      ([, init]) => JSON.parse(String(init?.body)).tool === 'modify_agent',
    );
    expect(JSON.parse(String(saveCall?.[1].body)).args.model).toEqual({
      model: 'DeepSeek-V4.1-Flash-1017',
    });
  });

  it('shows a friendly message when get_participant is denied', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}'));
        if (body.tool === 'get_participant')
          return new Response(JSON.stringify({ result: { status: 'error', error: 'hidden' } }), {
            status: 200,
          });
        if (body.tool === 'list_tools')
          return toolResponse('list_tools', { tools: ['communicate'], callerPolicy: {} });
        if (body.tool === 'list_models') return toolResponse('list_models', []);
        if (body.tool === 'list_middleware')
          return toolResponse('list_middleware', { definitions: [] });
        return toolResponse(body.tool, {});
      }),
    );
    const wrapper = mount(AgentEditor, { props: { participantId: 'agent-a' } });
    await vi.waitFor(() => expect(wrapper.find('[data-test="editor-error"]').exists()).toBe(true));
    const banner = wrapper.find('[data-test="editor-error"]').text();
    expect(banner).not.toContain('hidden');
    expect(banner).toContain('access');
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
    // New agents skip load(), so the model field stays a free-text input.
    await wrapper.find('[data-test="agent-model"]').setValue('gpt-4o');
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

  it('skips middleware save when the caller lacks set_participant_middleware', async () => {
    mockCan((tool) => (tool === 'modify_agent' ? 'auto' : 'hidden'));
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}'));
        calls.push(body.tool);
        if (body.tool === 'get_participant') return toolResponse('get_participant', AGENT);
        if (body.tool === 'list_tools')
          return toolResponse('list_tools', { tools: [], callerPolicy: {} });
        if (body.tool === 'list_models') return toolResponse('list_models', []);
        if (body.tool === 'list_middleware')
          return toolResponse('list_middleware', { definitions: [] });
        return toolResponse(body.tool, {});
      }),
    );
    const wrapper = mount(AgentEditor, { props: { participantId: 'agent-a' } });
    await vi.waitFor(() =>
      expect((wrapper.find('[data-test="agent-model"]').element as HTMLInputElement).value).toBe(
        'gpt-4o',
      ),
    );
    await wrapper.find('[data-test="agent-save"]').trigger('click');
    await flushPromises();
    expect(calls).toContain('modify_agent');
    expect(calls).not.toContain('set_participant_middleware');
    expect(wrapper.find('[data-test="editor-error"]').exists()).toBe(false);
  });

  it('skips middleware save on create when the caller lacks set_participant_middleware', async () => {
    mockCan((tool) => (tool === 'create_agent' ? 'auto' : 'hidden'));
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}'));
        calls.push(body.tool);
        return toolResponse(body.tool, {});
      }),
    );
    const wrapper = mount(AgentEditor, { props: { participantId: 'new' } });
    await wrapper.find('[data-test="agent-name"]').setValue('Fresh Agent');
    await wrapper.find('[data-test="agent-model"]').setValue('gpt-4o');
    await wrapper.find('[data-test="agent-save"]').trigger('click');
    await flushPromises();
    expect(calls).toContain('create_agent');
    expect(calls).not.toContain('set_participant_middleware');
    expect(wrapper.find('[data-test="editor-error"]').exists()).toBe(false);
  });

  it('notes that middleware is preserved when it cannot be saved', async () => {
    mockCan((tool) => (tool === 'modify_agent' ? 'auto' : 'hidden'));
    vi.stubGlobal('fetch', stubFetch());
    const wrapper = mount(AgentEditor, { props: { participantId: 'agent-a' } });
    await vi.waitFor(() =>
      expect((wrapper.find('[data-test="agent-model"]').element as HTMLInputElement).value).toBe(
        'gpt-4o',
      ),
    );
    const note = wrapper.find('[data-test="middleware-readonly"]');
    expect(note.exists()).toBe(true);
    expect(note.text()).toContain('preserved');
  });

  it('hydrates skills and credential keys for middleware editing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}'));
        if (body.tool === 'get_participant')
          return toolResponse('get_participant', { ...AGENT, middleware: MIDDLEWARE });
        if (body.tool === 'list_tools')
          return toolResponse('list_tools', { tools: [], callerPolicy: {} });
        if (body.tool === 'list_models') return toolResponse('list_models', []);
        if (body.tool === 'list_middleware')
          return toolResponse('list_middleware', { definitions: MIDDLEWARE_DEFINITIONS });
        if (body.tool === 'list_skills')
          return toolResponse('list_skills', {
            skills: [
              {
                name: 'brainstorming',
                description: 'Brainstorm',
                scope: 'global',
                location: '/skills/brainstorming/SKILL.md',
                baseDirectory: '/skills/brainstorming',
              },
            ],
            diagnostics: [],
          });
        if (body.tool === 'list_secrets')
          return toolResponse('list_secrets', {
            participantId: 'agent-a',
            keys: ['telegram-bot/x'],
          });
        return toolResponse(body.tool, {});
      }),
    );
    const wrapper = mount(AgentEditor, { props: { participantId: 'agent-a' } });
    await vi.waitFor(() =>
      expect(wrapper.find('[data-skill-option="brainstorming"]').exists()).toBe(true),
    );
    const credentialOptions = wrapper
      .find('[data-field="botToken"]')
      .findAll('option')
      .map((option) => option.text());
    expect(credentialOptions).toContain('telegram-bot/x');
  });

  it('does not fail the editor when list_secrets is denied for another participant', async () => {
    // list_secrets is self-or-operator only: an editor opened by a non-operator
    // for another participant gets a tool error, which must stay silent here.
    // The credential field is optional so save stays available, and it must show
    // no key options because `credentialKeys` stayed empty.
    const definitions = [
      {
        type: 'workspace:webhook',
        displayName: 'Webhook',
        defaultFailureMode: 'closed',
        configSchema: {
          type: 'object',
          properties: {
            token: { type: 'string', title: 'Token', format: 'credential-reference' },
          },
        },
        source: 'workspace',
      },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}'));
        if (body.tool === 'get_participant')
          return toolResponse('get_participant', {
            ...AGENT,
            middleware: [{ id: 'webhook-1', type: 'workspace:webhook', config: {} }],
          });
        if (body.tool === 'list_tools')
          return toolResponse('list_tools', { tools: [], callerPolicy: {} });
        if (body.tool === 'list_models') return toolResponse('list_models', []);
        if (body.tool === 'list_middleware')
          return toolResponse('list_middleware', { definitions });
        if (body.tool === 'list_skills') return toolResponse('list_skills', { skills: [] });
        if (body.tool === 'list_secrets')
          return new Response(
            JSON.stringify({
              result: {
                status: 'error',
                error: 'Only an operator can manage another participant secrets',
              },
            }),
            { status: 200 },
          );
        return toolResponse(body.tool, {});
      }),
    );
    const wrapper = mount(AgentEditor, { props: { participantId: 'agent-a' } });
    await vi.waitFor(() =>
      expect((wrapper.find('[data-test="agent-model"]').element as HTMLInputElement).value).toBe(
        'gpt-4o',
      ),
    );
    await vi.waitFor(() => expect(wrapper.find('[data-field="token"]').exists()).toBe(true));
    await flushPromises();
    expect(wrapper.find('[data-test="editor-error"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="agent-save"]').exists()).toBe(true);
    expect(
      wrapper
        .find('[data-field="token"]')
        .findAll('option')
        .map((option) => option.text()),
    ).toEqual(['Select credential...']);
  });

  it('blocks save while middleware config fails validation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}'));
        if (body.tool === 'get_participant')
          return toolResponse('get_participant', {
            ...AGENT,
            middleware: [{ id: 'telegram-1', type: 'workspace:telegram', config: {} }],
          });
        if (body.tool === 'list_tools')
          return toolResponse('list_tools', { tools: [], callerPolicy: {} });
        if (body.tool === 'list_models') return toolResponse('list_models', []);
        if (body.tool === 'list_middleware')
          return toolResponse('list_middleware', { definitions: MIDDLEWARE_DEFINITIONS });
        if (body.tool === 'list_skills') return toolResponse('list_skills', { skills: [] });
        if (body.tool === 'list_secrets')
          return toolResponse('list_secrets', { keys: ['telegram-bot/x'] });
        return toolResponse(body.tool, {});
      }),
    );
    const wrapper = mount(AgentEditor, { props: { participantId: 'agent-a' } });
    await vi.waitFor(() =>
      expect((wrapper.find('[data-test="agent-model"]').element as HTMLInputElement).value).toBe(
        'gpt-4o',
      ),
    );
    await vi.waitFor(() => expect(wrapper.text()).toContain('Bot token is required'));
    expect(wrapper.find('[data-test="agent-save"]').exists()).toBe(false);
    // Fixing the field clears the validation error and re-enables save.
    await wrapper.find('[data-field="botToken"]').setValue('telegram-bot/x');
    await vi.waitFor(() => expect(wrapper.find('[data-test="agent-save"]').exists()).toBe(true));
  });

  it('keeps save available for invalid middleware the caller cannot change', async () => {
    mockCan((tool) => (tool === 'modify_agent' ? 'auto' : 'hidden'));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}'));
        if (body.tool === 'get_participant')
          return toolResponse('get_participant', {
            ...AGENT,
            middleware: [{ id: 'telegram-1', type: 'workspace:telegram', config: {} }],
          });
        if (body.tool === 'list_tools')
          return toolResponse('list_tools', { tools: [], callerPolicy: {} });
        if (body.tool === 'list_models') return toolResponse('list_models', []);
        if (body.tool === 'list_middleware')
          return toolResponse('list_middleware', { definitions: MIDDLEWARE_DEFINITIONS });
        if (body.tool === 'list_skills') return toolResponse('list_skills', { skills: [] });
        if (body.tool === 'list_secrets') return toolResponse('list_secrets', { keys: [] });
        return toolResponse(body.tool, {});
      }),
    );
    const wrapper = mount(AgentEditor, { props: { participantId: 'agent-a' } });
    await vi.waitFor(() =>
      expect((wrapper.find('[data-test="agent-model"]').element as HTMLInputElement).value).toBe(
        'gpt-4o',
      ),
    );
    await vi.waitFor(() => expect(wrapper.text()).toContain('Bot token is required'));
    // Middleware cannot be written by this caller, so its invalid config is
    // preserved rather than dead-ending the agent edit.
    expect(wrapper.find('[data-test="agent-save"]').exists()).toBe(true);
  });

  it('preserves authority participants through load, edit and save', async () => {
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (body.tool === 'get_participant')
        return toolResponse('get_participant', {
          ...AGENT,
          approvalAuthority: { tools: { communicate: true }, participants: ['agent-a'] },
        });
      if (body.tool === 'list_tools')
        return toolResponse('list_tools', {
          tools: ['communicate', 'file_read'],
          callerPolicy: {},
        });
      if (body.tool === 'list_models') return toolResponse('list_models', []);
      if (body.tool === 'list_middleware')
        return toolResponse('list_middleware', { definitions: [] });
      if (body.tool === 'list_skills') return toolResponse('list_skills', { skills: [] });
      if (body.tool === 'list_secrets') return toolResponse('list_secrets', { keys: [] });
      return toolResponse(body.tool, {});
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(AgentEditor, { props: { participantId: 'agent-a' } });
    await vi.waitFor(() =>
      expect(wrapper.find('[data-test="tool-file_read"]').exists()).toBe(true),
    );
    expect(
      (wrapper.find('[data-test="tool-communicate"]').element as HTMLInputElement).checked,
    ).toBe(true);
    await wrapper.find('[data-test="tool-file_read"]').setValue(true);
    await wrapper.find('[data-test="authority-save"]').trigger('click');
    await vi.waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([, init]) => JSON.parse(String(init?.body)).tool === 'set_approval_authority',
      );
      expect(call).toBeDefined();
      expect(JSON.parse(String(call![1]?.body)).args.authority).toEqual({
        tools: { communicate: true, file_read: true },
        participants: ['agent-a'],
      });
    });
  });

  it('hides the authority save button for a new agent', async () => {
    vi.stubGlobal('fetch', stubFetch());
    const wrapper = mount(AgentEditor, { props: { participantId: 'new' } });
    await flushPromises();
    // The caller may set authority, but a participant does not exist yet.
    expect(wrapper.find('[data-test="authority-save"]').exists()).toBe(false);
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
        if (body.tool === 'list_middleware')
          return toolResponse('list_middleware', { definitions: [] });
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
