import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import ParticipantsView from './ParticipantsView.vue';
import { useParticipants } from '../composables/useParticipants.js';
import { useToolAccess } from '../composables/useToolAccess.js';
import { useParticipantSelection } from './useParticipantSelection.js';

// useLegionApi reads the auth token from localStorage-backed refs seeded
// at module init — seed at hoist time (before the module graph initializes).
vi.hoisted(() => {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  localStorage.setItem('legion-token', 'tok-123');
  localStorage.setItem('legion-expires-at', String(exp));
});

const ASSISTANT = {
  id: 'assistant',
  name: 'Assistant',
  type: 'agent',
  tools: {},
  status: 'active',
};

// Tool-aware fetch stub: every call gets a fresh Response (bodies are single-read).
function stubFetch(dataFor: (tool: string) => unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockImplementation((_url: unknown, init?: { body?: string }) => {
    const { tool } = JSON.parse(init?.body ?? '{}') as { tool: string };
    return Promise.resolve(
      new Response(JSON.stringify({ result: { status: 'success', data: dataFor(tool) } }), {
        status: 200,
      }),
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** happy-dom provides matchMedia (always matches=false); override to control viewport width. */
function stubViewport(narrow: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation(() => ({
      matches: narrow,
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  );
}

/** Fetch responder covering everything the participants view and its editors call. */
function stubParticipantApi(): ReturnType<typeof vi.fn> {
  return stubFetch((tool) => {
    if (tool === 'list_tools')
      return { tools: ['list_participants'], callerPolicy: { list_participants: 'auto' } };
    if (tool === 'list_participants') return [ASSISTANT];
    if (tool === 'get_participant') return ASSISTANT;
    if (tool === 'list_models') return [];
    if (tool === 'list_middleware') return { definitions: [] };
    return {};
  });
}

interface MountOptions {
  narrow: boolean;
  /** Seed the participants store directly (default); false exercises the network path. */
  seed?: boolean;
}

// Instances stay alive across tests unless unmounted; their watchers observe
// the module-scoped tool-access ref, so a refresh() in one test would fire
// every prior instance's watcher. Unmount everything between tests.
const mountedWrappers: ReturnType<typeof mount>[] = [];

async function mountParticipantsView({ narrow, seed = true }: MountOptions) {
  stubViewport(narrow);
  const fetchMock = stubParticipantApi();
  if (seed) useParticipants().__setParticipantsForTests([ASSISTANT] as never);
  const wrapper = mount(ParticipantsView);
  mountedWrappers.push(wrapper);
  await flushPromises();
  return { wrapper, fetchMock };
}

afterEach(() => {
  while (mountedWrappers.length > 0) mountedWrappers.pop()?.unmount();
});

beforeEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
  const exp = Math.floor(Date.now() / 1000) + 3600;
  localStorage.setItem('legion-token', 'tok-123');
  localStorage.setItem('legion-expires-at', String(exp));
  useParticipants().__resetForTests();
  useToolAccess().__resetForTests();
  useParticipantSelection().__resetForTests();
});

describe('ParticipantsView mobile single-pane layout', () => {
  it('shows only the list when narrow and nothing is selected', async () => {
    const { wrapper } = await mountParticipantsView({ narrow: true });
    expect(wrapper.find('[data-test="participants-list-pane"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="participant-detail-pane"]').exists()).toBe(false);
  });

  it('swaps to the detail pane with a back button after selecting', async () => {
    const { wrapper } = await mountParticipantsView({ narrow: true });
    await wrapper.find('[data-test="participant-row"]').trigger('click');
    expect(wrapper.find('[data-test="participant-detail-pane"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="participants-list-pane"]').exists()).toBe(false);
    await wrapper.find('[data-test="mobile-back"]').trigger('click');
    expect(wrapper.find('[data-test="participants-list-pane"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="participant-detail-pane"]').exists()).toBe(false);
  });

  it('shows both panes on wide viewports', async () => {
    const { wrapper } = await mountParticipantsView({ narrow: false });
    expect(wrapper.find('[data-test="participants-list-pane"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="participant-detail-pane"]').exists()).toBe(true);
  });
});

describe('ParticipantsView post-refresh reload', () => {
  it('skips the mount fetch while tool access is hidden, then loads once when it lands', async () => {
    const { wrapper, fetchMock } = await mountParticipantsView({ narrow: false, seed: false });
    const listCalls = () =>
      fetchMock.mock.calls.filter((call) => {
        const body = JSON.parse((call[1] as { body?: string } | undefined)?.body ?? '{}') as {
          tool?: string;
        };
        return body.tool === 'list_participants';
      }).length;
    // Deep-link/hard-reload: App.vue's refreshToolAccess resolves after this
    // view mounts, so can('list_participants') fails closed at mount — no fetch.
    expect(listCalls()).toBe(0);
    expect(wrapper.find('[data-test="participant-row"]').exists()).toBe(false);
    // The tool-access refresh lands (as App.vue does post-auth)...
    await useToolAccess().refresh();
    await flushPromises();
    // ...and the view loads exactly once — no double-load against the mount call.
    expect(listCalls()).toBe(1);
    expect(wrapper.find('[data-test="participant-row"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('Assistant');
  });
});
