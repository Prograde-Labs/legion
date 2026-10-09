import { describe, expect, it, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import McpSourcesEditor from './McpSourcesEditor.vue';

const MCP = [{ name: 'fs', command: 'npx', args: ['-y', 'fs-mcp'] }];

function stubFetch(): ReturnType<typeof vi.fn> {
  return vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (body.tool === 'list_mcp_sources') {
      return new Response(JSON.stringify({ result: { status: 'success', data: MCP } }), {
        status: 200,
      });
    }
    return new Response(JSON.stringify({ result: { status: 'success', data: {} } }), {
      status: 200,
    });
  });
}

describe('McpSourcesEditor', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
    localStorage.setItem('legion-token', 'tok');
    localStorage.setItem('legion-expires-at', String(Math.floor(Date.now() / 1000) + 3600));
  });

  it('loads and renders existing servers', async () => {
    vi.stubGlobal('fetch', stubFetch());
    const wrapper = mount(McpSourcesEditor);
    await vi.waitFor(() => expect(wrapper.findAll('[data-test="mcp-card"]').length).toBe(1));
    expect(wrapper.text()).toContain('fs');
    expect(wrapper.text()).toContain('stdio');
  });

  it('warns that a config.local.json mcpServers override shadows saved changes (OQ3)', async () => {
    vi.stubGlobal('fetch', stubFetch());
    const wrapper = mount(McpSourcesEditor);
    await vi.waitFor(() => expect(wrapper.findAll('[data-test="mcp-card"]').length).toBe(1));
    const warning = wrapper.find('[data-test="config-local-shadow-warning"]');
    expect(warning.exists()).toBe(true);
    expect(warning.text()).toContain('config.local.json');
    expect(warning.text()).toContain('shadow');
  });

  it('add creates a blank card; save sends the full list', async () => {
    const fetchMock = stubFetch();
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(McpSourcesEditor);
    // vitest 5 waitFor only retries on thrown errors, so poll on card presence
    // (implies the initial load resolved and the add-server button is rendered).
    await vi.waitFor(() => expect(wrapper.findAll('[data-test="mcp-card"]').length).toBe(1));
    await wrapper.find('[data-test="add-server"]').trigger('click');
    const cards = wrapper.findAll('[data-test="mcp-card"]');
    await cards[1].find('input[name="name"]').setValue('websearch');
    await cards[1].find('input[name="url"]').setValue('http://localhost:3000/mcp');
    await wrapper.find('button[data-test="mcp-save"]').trigger('click');
    await vi.waitFor(() => {
      const saveCall = fetchMock.mock.calls.find(
        (c) => JSON.parse(String(c[1]?.body)).tool === 'save_mcp_sources',
      );
      expect(saveCall).toBeDefined();
      const body = JSON.parse(String(saveCall![1]?.body));
      expect(body.args.servers.length).toBe(2);
      expect(body.args.servers[1]).toEqual({ name: 'websearch', url: 'http://localhost:3000/mcp' });
    });
  });

  it('client-side duplicate name check blocks save', async () => {
    const fetchMock = stubFetch();
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(McpSourcesEditor);
    // vitest 5 waitFor only retries on thrown errors, so poll on card presence
    // (implies the initial load resolved and the add-server button is rendered).
    await vi.waitFor(() => expect(wrapper.findAll('[data-test="mcp-card"]').length).toBe(1));
    await wrapper.find('[data-test="add-server"]').trigger('click');
    const cards = wrapper.findAll('[data-test="mcp-card"]');
    await cards[1].find('input[name="name"]').setValue('fs');
    await cards[1].find('input[name="command"]').setValue('x');
    await wrapper.find('button[data-test="mcp-save"]').trigger('click');
    await wrapper.vm.$nextTick();
    expect(
      fetchMock.mock.calls.some((c) => JSON.parse(String(c[1]?.body)).tool === 'save_mcp_sources'),
    ).toBe(false);
    expect(wrapper.text()).toContain('duplicate');
  });
});
