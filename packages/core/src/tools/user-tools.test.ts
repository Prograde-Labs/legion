import { MemoryStorage } from '../storage/MemoryStorage.js';
import { Collective } from '../collective/Collective.js';
import { userTools } from './user-tools.js';
import type { ToolContext } from './Tool.js';
import type { UserConfig } from '@legion-collective/types';

async function makeContext(): Promise<{ context: ToolContext; collective: Collective }> {
  const storage = new MemoryStorage();
  const collective = await Collective.load(storage);
  await collective.seedDefaultsIfEmpty();
  const context = { collective } as unknown as ToolContext;
  return { context, collective };
}

const [createUserTool, modifyUserTool] = userTools;

describe('create_user', () => {
  it('creates a user participant with defaults', async () => {
    const { context, collective } = await makeContext();
    const result = await createUserTool.execute({ id: 'alice', name: 'Alice' }, context);
    expect(result.status).toBe('success');
    const user = collective.get('alice') as UserConfig | undefined;
    expect(user?.type).toBe('user');
    expect(user?.status).toBe('active');
    expect(user?.tools).toEqual({});
  });

  it('rejects a duplicate id', async () => {
    const { context } = await makeContext();
    await createUserTool.execute({ id: 'alice', name: 'Alice' }, context);
    const result = await createUserTool.execute({ id: 'alice', name: 'Alice 2' }, context);
    expect(result.status).toBe('error');
    expect(result.error).toContain('Participant already exists');
  });

  it('accepts operator and tools overrides', async () => {
    const { context, collective } = await makeContext();
    const result = await createUserTool.execute(
      { id: 'bob', name: 'Bob', operator: true, tools: { list_participants: 'auto' } },
      context,
    );
    expect(result.status).toBe('success');
    const user = collective.get('bob') as UserConfig;
    expect(user.operator).toBe(true);
    expect(user.tools).toEqual({ list_participants: 'auto' });
  });
});

describe('modify_user', () => {
  it('renames and flips operator', async () => {
    const { context, collective } = await makeContext();
    await createUserTool.execute({ id: 'alice', name: 'Alice' }, context);
    const result = await modifyUserTool.execute(
      { id: 'alice', name: 'Alice B', operator: true },
      context,
    );
    expect(result.status).toBe('success');
    const user = collective.get('alice') as UserConfig;
    expect(user.name).toBe('Alice B');
    expect(user.operator).toBe(true);
  });

  it('clears the tools map on empty object (full replacement)', async () => {
    const { context, collective } = await makeContext();
    await createUserTool.execute(
      { id: 'alice', name: 'Alice', tools: { communicate: 'auto' } },
      context,
    );
    const result = await modifyUserTool.execute({ id: 'alice', tools: {} }, context);
    expect(result.status).toBe('success');
    expect((collective.get('alice') as UserConfig).tools).toEqual({});
  });

  it('keeps tools when omitted', async () => {
    const { context, collective } = await makeContext();
    await createUserTool.execute(
      { id: 'alice', name: 'Alice', tools: { communicate: 'auto' } },
      context,
    );
    await modifyUserTool.execute({ id: 'alice', name: 'Alice B' }, context);
    expect((collective.get('alice') as UserConfig).tools).toEqual({ communicate: 'auto' });
  });

  it('rejects non-user participants', async () => {
    const { context, collective } = await makeContext();
    await collective.add({ id: 'svc', name: 'Svc', type: 'service', tools: {}, module: 'test' });
    const result = await modifyUserTool.execute({ id: 'svc' }, context);
    expect(result.status).toBe('error');
    expect(result.error).toContain('not a user');
  });

  it('rejects unknown ids', async () => {
    const { context } = await makeContext();
    const result = await modifyUserTool.execute({ id: 'ghost' }, context);
    expect(result.status).toBe('error');
  });
});
