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

  it('refuses to create a user with a password when set_credential is unavailable', async () => {
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
    await wrapper.find('input[name="new-password"]').setValue('long-enough-pass');
    await wrapper.find('input[name="confirm-password"]').setValue('long-enough-pass');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(calls).not.toContain('create_user');
    expect(wrapper.find('[data-test="editor-error"]').text()).toContain('credential');
  });

  it('hides the operator checkbox for non-operator callers', async () => {
    seedParticipants(false);
    vi.stubGlobal('fetch', stubFetch({ ...USER, operator: true }));
    const wrapper = mount(UserEditor, { props: { participantId: 'alice' } });
    await waitLoaded(wrapper);
    expect(wrapper.find('input[name="operator"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('Operator: yes (read-only)');
  });

  it('does not send the operator flag when the caller cannot grant it', async () => {
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
      expect(JSON.parse(String(call![1]?.body)).args).not.toHaveProperty('operator');
    });
  });

  it('refuses to create a user with a password when the caller cannot set that credential', async () => {
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
    await wrapper.find('input[name="new-password"]').setValue('long-enough-pass');
    await wrapper.find('input[name="confirm-password"]').setValue('long-enough-pass');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(calls).not.toContain('create_user');
    expect(calls).not.toContain('set_credential');
    expect(wrapper.find('[data-test="editor-error"]').text()).toContain('credential');
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
});
