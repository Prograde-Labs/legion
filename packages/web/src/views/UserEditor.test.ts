import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import UserEditor from './UserEditor.vue';
import { useAuth } from '../composables/useAuth.js';

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
    if (body.tool === 'list_tools') return toolResponse('list_tools', ['communicate', 'file_read']);
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

function waitLoaded(wrapper: ReturnType<typeof mount>): Promise<void> {
  // 'form' always exists; wait until get_participant data actually populated the name.
  return vi.waitFor(() =>
    expect((wrapper.find('input[name="name"]').element as HTMLInputElement).value).toBe('Alice'),
  );
}

describe('UserEditor', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
    seedAuth();
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
    // wait for the first save to complete (it clears password fields when done)
    // so it cannot race-wipe the values typed below before the second submit reads them.
    await vi.waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([, init]) => JSON.parse(String(init?.body)).tool === 'modify_user',
        ),
      ).toBe(true);
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
});
