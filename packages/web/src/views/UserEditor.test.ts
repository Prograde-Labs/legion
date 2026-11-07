import { describe, expect, it, vi, beforeEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import UserEditor from './UserEditor.vue';
import { useAuth } from '../composables/useAuth.js';
import { useParticipants } from '../composables/useParticipants.js';
import { useToolAccess } from '../composables/useToolAccess.js';
import type { BaseParticipant } from '@legion-collective/types';

vi.mock('../composables/useToolAccess.js', () => ({ useToolAccess: vi.fn() }));

function mockCan(can: (tool: string) => 'auto' | 'requires_approval' | 'hidden'): void {
  vi.mocked(useToolAccess).mockReturnValue({ can } as never);
}

const USER = {
  id: 'alice',
  name: 'Alice',
  type: 'user',
  status: 'active',
  tools: { communicate: 'auto' },
  operator: false,
  identities: [{ connector: 'web', externalId: 'alice' }],
};

function toolResponse(tool: string, data: unknown): Response {
  void tool;
  return new Response(JSON.stringify({ result: { status: 'success', data } }), { status: 200 });
}

function stubFetch(participant: unknown = USER): ReturnType<typeof vi.fn> {
  return vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (body.tool === 'get_participant') return toolResponse('get_participant', participant);
    if (body.tool === 'list_tools')
      return toolResponse('list_tools', { tools: ['communicate', 'file_read'], callerPolicy: {} });
    return toolResponse('other', {});
  });
}

function seedAuth(participantId = 'operator'): void {
  localStorage.setItem('legion-token', 'tok');
  localStorage.setItem('legion-expires-at', String(Math.floor(Date.now() / 1000) + 3600));
  localStorage.setItem('legion-participant-id', participantId);
  // useAuth's participantId is a module-scoped useLocalStorage ref that reads at
  // import; post-import localStorage writes don't move it, so set the ref directly.
  useAuth().participantId.value = participantId;
}

/**
 * Seed the roster exactly as `list_participants` returns it (no tools or
 * approvalAuthority; `operator` is only emitted for users).
 */
function seedRoster(entries: Array<{ id: string; operator: boolean }>): void {
  useParticipants().__setParticipantsForTests(
    entries.map(
      (entry) =>
        ({
          id: entry.id,
          name: entry.id,
          type: 'user',
          status: 'active',
          middleware: [],
          middlewareRevision: 0,
          operator: entry.operator,
        }) as unknown as BaseParticipant,
    ),
  );
}

function seedParticipants(operator = true): void {
  seedRoster([{ id: 'operator', operator }]);
}

function waitLoaded(wrapper: ReturnType<typeof mount>): Promise<void> {
  // 'form' always exists; wait until get_participant data actually populated the name.
  return vi.waitFor(() =>
    expect((wrapper.find('input[name="name"]').element as HTMLInputElement).value).toBe('Alice'),
  );
}

describe('UserEditor', () => {
  beforeEach(() => {
    mockCan(() => 'auto');
    localStorage.clear();
    vi.unstubAllGlobals();
    seedAuth();
    seedParticipants();
  });

  it('prefills name, operator flag and read-only identities', async () => {
    vi.stubGlobal('fetch', stubFetch());
    const wrapper = mount(UserEditor, { props: { participantId: 'alice' } });
    await vi.waitFor(() =>
      expect((wrapper.find('input[name="name"]').element as HTMLInputElement).value).toBe('Alice'),
    );
    expect(wrapper.find('[data-test="identities"]').text()).toContain('web: alice');
    expect((wrapper.find('input[name="operator"]').element as HTMLInputElement).checked).toBe(
      false,
    );
  });

  it('hydrates name, operator flag and tool override policies for an existing user', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}'));
        if (body.tool === 'get_participant')
          return toolResponse('get_participant', {
            ...USER,
            name: 'Alice Prime',
            operator: true,
            tools: { communicate: 'auto', file_read: 'requires_approval' },
            approvalAuthority: { tools: { communicate: true } },
          });
        if (body.tool === 'list_tools')
          return toolResponse('list_tools', {
            tools: ['communicate', 'file_read', 'list_tools'],
            callerPolicy: {},
          });
        return toolResponse(body.tool, {});
      }),
    );
    const wrapper = mount(UserEditor, { props: { participantId: 'alice' } });
    await vi.waitFor(() =>
      expect((wrapper.find('input[name="name"]').element as HTMLInputElement).value).toBe(
        'Alice Prime',
      ),
    );
    expect((wrapper.find('input[name="operator"]').element as HTMLInputElement).checked).toBe(true);
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
    // Approval authority hydrates too — communicate allowed, wildcard off.
    expect((wrapper.find('[data-test="wildcard"]').element as HTMLInputElement).checked).toBe(
      false,
    );
    expect(
      (wrapper.find('[data-test="tool-communicate"]').element as HTMLInputElement).checked,
    ).toBe(true);
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
        return toolResponse(body.tool, {});
      }),
    );
    const wrapper = mount(UserEditor, { props: { participantId: 'alice' } });
    await vi.waitFor(() => expect(wrapper.find('[data-test="editor-error"]').exists()).toBe(true));
    const banner = wrapper.find('[data-test="editor-error"]').text();
    expect(banner).not.toContain('hidden');
    expect(banner).toContain('access');
  });

  it('save calls modify_user with full-replacement tools', async () => {
    const fetchMock = stubFetch();
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(UserEditor, { props: { participantId: 'alice' } });
    await waitLoaded(wrapper);
    // happy-dom does not dispatch submit on submit-button click; trigger the form directly.
    await wrapper.find('form').trigger('submit');
    await vi.waitFor(() => {
      const call = fetchMock.mock.calls.find(
        (c) => JSON.parse(String(c[1]?.body)).tool === 'modify_user',
      );
      expect(call).toBeDefined();
      expect(JSON.parse(String(call![1]?.body)).args.tools).toEqual({ communicate: 'auto' });
    });
  });

  it('save persists approval authority via set_approval_authority (modify_user has no authority param)', async () => {
    const fetchMock = stubFetch();
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(UserEditor, { props: { participantId: 'alice' } });
    await waitLoaded(wrapper);
    // The shared editor loads authority from get_participant (null here → unchecked);
    // toggle the wildcard on so the saved payload carries it.
    await wrapper.find('[data-test="wildcard"]').setValue(true);
    await wrapper.find('form').trigger('submit');
    await vi.waitFor(() => {
      const call = fetchMock.mock.calls.find(
        (c) => JSON.parse(String(c[1]?.body)).tool === 'set_approval_authority',
      );
      expect(call).toBeDefined();
      const args = JSON.parse(String(call![1]?.body)).args;
      expect(args.participantId).toBe('alice');
      expect(args.authority).toEqual({ tools: '*' });
    });
  });

  it('preserves authority participants through load, edit and save', async () => {
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (body.tool === 'get_participant')
        return toolResponse('get_participant', {
          ...USER,
          approvalAuthority: { tools: { communicate: true }, participants: ['alice'] },
        });
      if (body.tool === 'list_tools')
        return toolResponse('list_tools', {
          tools: ['communicate', 'file_read'],
          callerPolicy: {},
        });
      return toolResponse('other', {});
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(UserEditor, { props: { participantId: 'alice' } });
    await waitLoaded(wrapper);
    await vi.waitFor(() =>
      expect(wrapper.find('[data-test="tool-file_read"]').exists()).toBe(true),
    );
    expect(
      (wrapper.find('[data-test="tool-communicate"]').element as HTMLInputElement).checked,
    ).toBe(true);
    await wrapper.find('[data-test="tool-file_read"]').setValue(true);
    await wrapper.find('form').trigger('submit');
    await vi.waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([, init]) => JSON.parse(String(init?.body)).tool === 'set_approval_authority',
      );
      expect(call).toBeDefined();
      expect(JSON.parse(String(call![1]?.body)).args.authority).toEqual({
        tools: { communicate: true, file_read: true },
        participants: ['alice'],
      });
    });
  });

  it('password fields enforce min 8 + match before calling set_credential', async () => {
    const fetchMock = stubFetch();
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(UserEditor, { props: { participantId: 'alice' } });
    await waitLoaded(wrapper);
    await wrapper.find('input[name="new-password"]').setValue('short');
    await wrapper.find('form').trigger('submit');
    expect(
      fetchMock.mock.calls.some(
        ([, init]) => JSON.parse(String(init?.body)).tool === 'set_credential',
      ),
    ).toBe(false);
    // wait for the first save to fully complete (its tail clears the password
    // fields) so it cannot race-wipe the values typed below before the second
    // submit reads them. modify_user-seen is NOT enough — the save tail runs
    // several awaits past it.
    await vi.waitFor(() => {
      expect((wrapper.find('input[name="new-password"]').element as HTMLInputElement).value).toBe(
        '',
      );
    });
    await wrapper.find('input[name="new-password"]').setValue('long-enough-pass');
    await wrapper.find('input[name="confirm-password"]').setValue('long-enough-pass');
    await wrapper.find('form').trigger('submit');
    await vi.waitFor(() => {
      const cred = fetchMock.mock.calls
        .map(([, init]) => JSON.parse(String(init?.body)))
        .find((b) => b.tool === 'set_credential');
      expect(cred).toBeDefined();
      expect(cred!.args).toEqual({ participantId: 'alice', secret: 'long-enough-pass' });
    });
  });

  it('retire is hidden for protected users', async () => {
    vi.stubGlobal('fetch', stubFetch({ ...USER, protected: true, operator: true }));
    const wrapper = mount(UserEditor, { props: { participantId: 'alice' } });
    await waitLoaded(wrapper);
    expect(wrapper.find('[data-test="retire"]').exists()).toBe(false);
  });

  it('retire is disabled for self with a tooltip', async () => {
    vi.stubGlobal('fetch', stubFetch());
    const wrapper = mount(UserEditor, { props: { participantId: 'alice' } });
    await waitLoaded(wrapper);
    // token participantId is 'operator' here, so alice is NOT self — enable the self case:
    useAuth().participantId.value = 'alice';
    const wrapper2 = mount(UserEditor, { props: { participantId: 'alice' } });
    await waitLoaded(wrapper2);
    const retire = wrapper2.find('[data-test="retire"]');
    expect(retire.exists()).toBe(true);
    expect((retire.element as HTMLButtonElement).disabled).toBe(true);
    expect(retire.attributes('title')).toContain('cannot retire yourself');
  });

  it('hides save/retire and the password section without the matching tool access', async () => {
    mockCan((t) => (t === 'get_participant' || t === 'list_tools' ? 'auto' : 'hidden'));
    vi.stubGlobal('fetch', stubFetch());
    const wrapper = mount(UserEditor, { props: { participantId: 'alice' } });
    await waitLoaded(wrapper);
    expect(wrapper.find('[data-test="save"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="retire"]').exists()).toBe(false);
    expect(wrapper.find('input[name="new-password"]').exists()).toBe(false);
  });

  it('skips authority save when the caller lacks set_approval_authority', async () => {
    mockCan((tool) => (tool === 'modify_user' ? 'auto' : 'hidden'));
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}'));
        calls.push(body.tool);
        if (body.tool === 'get_participant') return toolResponse('get_participant', USER);
        if (body.tool === 'list_tools')
          return toolResponse('list_tools', { tools: ['communicate'], callerPolicy: {} });
        return toolResponse(body.tool, {});
      }),
    );
    const wrapper = mount(UserEditor, { props: { participantId: 'alice' } });
    await waitLoaded(wrapper);
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(calls).toContain('modify_user');
    expect(calls).not.toContain('set_approval_authority');
    expect(wrapper.find('[data-test="editor-error"]').exists()).toBe(false);
  });

  it('hides the password section when set_credential is unavailable', async () => {
    mockCan((tool) => (tool === 'create_user' ? 'auto' : 'hidden'));
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}'));
        calls.push(body.tool);
        return toolResponse(body.tool, {});
      }),
    );
    const wrapper = mount(UserEditor, { props: { participantId: 'new' } });
    await wrapper.find('[data-test="user-name"]').setValue('New User');
    expect(wrapper.find('input[name="new-password"]').exists()).toBe(false);
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    // The user is created without a credential rather than dead-ending on a
    // field whose save would abort.
    expect(calls).toContain('create_user');
    expect(calls).not.toContain('set_credential');
    expect(wrapper.find('[data-test="editor-error"]').exists()).toBe(false);
  });

  it('hides the operator checkbox for non-operator callers', async () => {
    seedParticipants(false);
    vi.stubGlobal('fetch', stubFetch({ ...USER, operator: true }));
    const wrapper = mount(UserEditor, { props: { participantId: 'alice' } });
    await waitLoaded(wrapper);
    expect(wrapper.find('input[name="operator"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('Operator: yes (read-only)');
  });

  it('does not send the operator flag or tools map when the caller cannot change them', async () => {
    seedParticipants(false);
    const fetchMock = stubFetch({ ...USER, operator: true });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(UserEditor, { props: { participantId: 'alice' } });
    await waitLoaded(wrapper);
    await wrapper.find('form').trigger('submit');
    await vi.waitFor(() => {
      const call = fetchMock.mock.calls.find(
        (c) => JSON.parse(String(c[1]?.body)).tool === 'modify_user',
      );
      expect(call).toBeDefined();
      const args = JSON.parse(String(call![1]?.body)).args;
      expect(args).not.toHaveProperty('operator');
      // Non-operator tool-policy mutations are rejected server-side; omit the
      // map so the rename still succeeds and existing policies are preserved.
      expect(args).not.toHaveProperty('tools');
    });
  });

  it('hides the password section for a non-operator editing another user', async () => {
    seedParticipants(false);
    mockCan((tool) => (tool === 'modify_user' || tool === 'set_credential' ? 'auto' : 'hidden'));
    vi.stubGlobal('fetch', stubFetch());
    const wrapper = mount(UserEditor, { props: { participantId: 'alice' } });
    await waitLoaded(wrapper);
    expect(wrapper.find('[data-test="save"]').exists()).toBe(true);
    // set_credential would abort for another user, so do not render a field that
    // is guaranteed to fail.
    expect(wrapper.find('input[name="new-password"]').exists()).toBe(false);
    expect(wrapper.find('input[name="confirm-password"]').exists()).toBe(false);
  });

  it('uses the loaded operator flag (not the edited form) for last-operator checks', async () => {
    // Caller is an operator but retired; alice is the only active operator.
    useParticipants().__setParticipantsForTests([
      { id: 'operator', name: 'operator', type: 'user', status: 'retired', operator: true },
      { id: 'alice', name: 'alice', type: 'user', status: 'active', operator: true },
    ] as unknown as BaseParticipant[]);
    vi.stubGlobal('fetch', stubFetch({ ...USER, operator: true }));
    const wrapper = mount(UserEditor, { props: { participantId: 'alice' } });
    await waitLoaded(wrapper);
    // Toggling the form value off must not make alice look like a non-operator:
    // the persisted participant is still the last active operator.
    await wrapper.find('input[name="operator"]').setValue(false);
    const retire = wrapper.find('[data-test="retire"]');
    expect(retire.exists()).toBe(true);
    expect((retire.element as HTMLButtonElement).disabled).toBe(true);
    expect(retire.attributes('title')).toContain('last active operator');
  });

  it('hides the password section for a non-operator creating a user', async () => {
    seedParticipants(false);
    mockCan((tool) => (tool === 'create_user' || tool === 'set_credential' ? 'auto' : 'hidden'));
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}'));
        calls.push(body.tool);
        return toolResponse(body.tool, {});
      }),
    );
    const wrapper = mount(UserEditor, { props: { participantId: 'new' } });
    await wrapper.find('[data-test="user-name"]').setValue('New User');
    // Creating a user with a password requires an operator (a new user is never
    // self), so the field must not be offered to a non-operator.
    expect(wrapper.find('input[name="new-password"]').exists()).toBe(false);
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(calls).toContain('create_user');
    expect(calls).not.toContain('set_credential');
    expect(wrapper.find('[data-test="editor-error"]').exists()).toBe(false);
  });

  it('lets a non-operator change their own password', async () => {
    seedParticipants(false);
    seedAuth('alice');
    mockCan((tool) => (tool === 'modify_user' || tool === 'set_credential' ? 'auto' : 'hidden'));
    const fetchMock = stubFetch();
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(UserEditor, { props: { participantId: 'alice' } });
    await waitLoaded(wrapper);
    await wrapper.find('input[name="new-password"]').setValue('long-enough-pass');
    await wrapper.find('input[name="confirm-password"]').setValue('long-enough-pass');
    await wrapper.find('form').trigger('submit');
    await vi.waitFor(() => {
      const cred = fetchMock.mock.calls
        .map(([, init]) => JSON.parse(String(init?.body)))
        .find((b) => b.tool === 'set_credential');
      expect(cred).toBeDefined();
      expect(cred!.args).toEqual({ participantId: 'alice', secret: 'long-enough-pass' });
    });
  });

  it('disables retire for the last active operator using the roster flag', async () => {
    seedRoster([
      { id: 'operator', operator: false },
      { id: 'alice', operator: true },
    ]);
    vi.stubGlobal('fetch', stubFetch({ ...USER, operator: true }));
    const wrapper = mount(UserEditor, { props: { participantId: 'alice' } });
    await waitLoaded(wrapper);
    const retire = wrapper.find('[data-test="retire"]');
    expect(retire.exists()).toBe(true);
    expect((retire.element as HTMLButtonElement).disabled).toBe(true);
    expect(retire.attributes('title')).toContain('last active operator');
  });

  it('notes that approval authority is preserved when it cannot be saved', async () => {
    mockCan((tool) => (tool === 'modify_user' ? 'auto' : 'hidden'));
    vi.stubGlobal('fetch', stubFetch());
    const wrapper = mount(UserEditor, { props: { participantId: 'alice' } });
    await waitLoaded(wrapper);
    const note = wrapper.find('[data-test="authority-readonly"]');
    expect(note.exists()).toBe(true);
    expect(note.text()).toContain('preserved');
  });

  it('renders tool policies read-only for a non-operator with a preserved note', async () => {
    seedAuth('alice');
    seedRoster([{ id: 'alice', operator: false }]);
    mockCan((tool) => (tool === 'modify_user' ? 'auto' : 'hidden'));
    vi.stubGlobal('fetch', stubFetch());
    const wrapper = mount(UserEditor, { props: { participantId: 'alice' } });
    await waitLoaded(wrapper);
    await vi.waitFor(() => expect(wrapper.find('[data-tool-row]').exists()).toBe(true));

    const note = wrapper.find('[data-test="tools-readonly"]');
    expect(note.exists()).toBe(true);
    expect(note.text()).toContain('preserved');
    const checkboxes = wrapper.findAll('[data-tool-row] input');
    expect(checkboxes.length).toBeGreaterThan(0);
    for (const checkbox of checkboxes) {
      expect((checkbox.element as HTMLInputElement).disabled).toBe(true);
    }
  });

  it('skips authority save on create when the caller lacks set_approval_authority', async () => {
    mockCan((tool) => (tool === 'create_user' ? 'auto' : 'hidden'));
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}'));
        calls.push(body.tool);
        return toolResponse(body.tool, {});
      }),
    );
    const wrapper = mount(UserEditor, { props: { participantId: 'new' } });
    await wrapper.find('[data-test="user-name"]').setValue('New User');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(calls).toContain('create_user');
    expect(calls).not.toContain('set_approval_authority');
    expect(wrapper.find('[data-test="editor-error"]').exists()).toBe(false);
  });

  it('saves the object policy form when a scope is present', async () => {
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (body.tool === 'get_participant')
        return toolResponse('get_participant', {
          ...USER,
          tools: {
            communicate: { policy: 'auto', scope: { message: { maxLength: 50 } } },
          },
        });
      if (body.tool === 'list_tools')
        return toolResponse('list_tools', { tools: ['communicate'], callerPolicy: {} });
      if (body.tool === 'modify_user') return toolResponse('modify_user', { id: 'alice' });
      return toolResponse(body.tool, {});
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(UserEditor, { props: { participantId: 'alice' } });
    await waitLoaded(wrapper);
    await wrapper.find('form').trigger('submit');
    await vi.waitFor(() => {
      const call = fetchMock.mock.calls.find(
        (c) => JSON.parse(String(c[1]?.body)).tool === 'modify_user',
      );
      expect(call).toBeDefined();
      expect(JSON.parse(String(call![1]?.body)).args.tools).toEqual({
        communicate: { policy: 'auto', scope: { message: { maxLength: 50 } } },
      });
    });
  });
});
