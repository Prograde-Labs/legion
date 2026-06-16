import type { Tool } from './Tool.js';
import type { ToolSource } from './ToolSource.js';

describe('ToolSource interface', () => {
  it('can be implemented with only load()', () => {
    const source: ToolSource = {
      async load(): Promise<Tool[]> {
        return [];
      },
    };
    expect(typeof source.load).toBe('function');
    expect(source.unload).toBeUndefined();
  });

  it('can be implemented with both load() and unload()', () => {
    let unloaded = false;
    const source: ToolSource = {
      async load(): Promise<Tool[]> {
        return [];
      },
      async unload(): Promise<void> {
        unloaded = true;
      },
    };
    expect(typeof source.unload).toBe('function');
    // Confirm unload() is callable.
    source.unload!();
    expect(unloaded).toBe(true);
  });

  it('load() returns a Tool array', async () => {
    const source: ToolSource = {
      async load(): Promise<Tool[]> {
        return [
          {
            name: 'fake_tool',
            description: 'test',
            parameters: { type: 'object', properties: {} },
            async execute(_args, _ctx) {
              return { status: 'success', data: null };
            },
          },
        ];
      },
    };
    const tools = await source.load();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('fake_tool');
  });
});
