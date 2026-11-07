import { MemoryStorage } from '../storage/MemoryStorage.js';
import { Collective } from '../collective/Collective.js';
import { userTools } from './user-tools.js';
import type { ToolContext } from './Tool.js';
import type { ParticipantConfig, UserConfig } from '@legion-collective/types';

/** Caller fixture; defaults to the seeded bootstrap operator. */
function caller(overrides: Partial<UserConfig> = {}): UserConfig {
  return {
    id: 'operator',
    name: 'Operator',
    type: 'user',
    tools: {},
    operator: true,
    ...overrides,
  };
}

async function makeContext(
  participant: ParticipantConfig = caller(),
): Promise<{ context: ToolContext; collective: Collective }> {
  const storage = new MemoryStorage();
  const collective = await Collective.load(storage);
  await collective.seedDefaultsIfEmpty();
  const context = { collective, participant } as unknown as ToolContext;
  return { context, collective };
}

const [createUserTool, modifyUserTool] = userTools;

/** Boot-equivalent subscription tools every new user must get to be live. */
const SUBSCRIPTION_TOOLS = {
  list_pending_approvals: 'auto',
  cancel_stream: 'auto',
  watch_activity: 'auto',
  watch_conversation: 'auto',
  watch_conversations: 'auto',
};

describe('create_user', () => {
  it('creates a user participant with default live subscription tools', async () => {
    const { context, collective } = await makeContext();
    const result = await createUserTool.execute({ id: 'alice', name: 'Alice' }, context);
    expect(result.status).toBe('success');
    const user = collective.get('alice') as UserConfig | undefined;
    expect(user?.type).toBe('user');
    expect(user?.status).toBe('active');
    // Users created after boot must get the same read/subscription grant that
    // ensureBootstrapRuntimeToolPolicies applies, or their UI is dead until a
    // restart.
    expect(user?.tools).toEqual(SUBSCRIPTION_TOOLS);
  });

  it('merges subscription tools with explicitly supplied tool policies', async () => {
    const { context, collective } = await makeContext();
    const result = await createUserTool.execute(
      { id: 'carol', name: 'Carol', tools: { communicate: 'auto' } },
      context,
    );
    expect(result.status).toBe('success');
    expect((collective.get('carol') as UserConfig).tools).toEqual({
      ...SUBSCRIPTION_TOOLS,
      communicate: 'auto',
    });
  });

  it('rejects a duplicate id', async () => {
    const { context } = await makeContext();
    await createUserTool.execute({ id: 'alice', name: 'Alice' }, context);
    const result = await createUserTool.execute({ id: 'alice', name: 'Alice 2' }, context);
    expect(result.status).toBe('error');
    expect(result.error).toContain('Participant already exists');
  });

  it('create_user accepts an object policy form', async () => {
    const { context, collective } = await makeContext();
    const result = await createUserTool.execute(
      {
        id: 'dave',
        name: 'Dave',
        tools: { communicate: { policy: 'auto', scope: { message: { maxLength: 50 } } } },
      },
      context,
    );
    expect(result.status).toBe('success');
    expect((collective.get('dave') as UserConfig).tools['communicate']).toEqual({
      policy: 'auto',
      scope: { message: { maxLength: 50 } },
    });
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
    expect(user.tools).toEqual({ ...SUBSCRIPTION_TOOLS, list_participants: 'auto' });
  });

  it('refuses to grant operator unless the caller is an operator', async () => {
    const { context, collective } = await makeContext(caller({ id: 'u1', operator: false }));
    const result = await createUserTool.execute({ id: 'u2', name: 'U2', operator: true }, context);
    expect(result.status).toBe('error');
    expect(result.error).toContain('operator');
    expect(collective.get('u2')).toBeUndefined();
  });

  it('allows an operator to grant operator', async () => {
    const { context, collective } = await makeContext();
    const result = await createUserTool.execute({ id: 'u2', name: 'U2', operator: true }, context);
    expect(result.status).toBe('success');
    expect((collective.get('u2') as UserConfig).operator).toBe(true);
  });

  it('lets a non-operator create a non-operator user', async () => {
    const { context, collective } = await makeContext(caller({ id: 'u1', operator: false }));
    const result = await createUserTool.execute({ id: 'u2', name: 'U2' }, context);
    expect(result.status).toBe('success');
    expect((collective.get('u2') as UserConfig).operator).toBeUndefined();
    expect((collective.get('u2') as UserConfig).tools).toEqual(SUBSCRIPTION_TOOLS);
  });

  it('refuses an explicit operator flag from a non-operator', async () => {
    const { context, collective } = await makeContext(caller({ id: 'u1', operator: false }));
    const result = await createUserTool.execute({ id: 'u2', name: 'U2', operator: false }, context);
    expect(result.status).toBe('error');
    expect(result.error).toContain('operator');
    expect(collective.get('u2')).toBeUndefined();
  });

  it('refuses a tools map from a non-operator (no privilege escalation)', async () => {
    const { context, collective } = await makeContext(caller({ id: 'u1', operator: false }));
    const result = await createUserTool.execute(
      { id: 'u2', name: 'U2', tools: { save_mcp_sources: 'auto' } },
      context,
    );
    expect(result.status).toBe('error');
    expect(result.error).toContain('tool polic');
    expect(collective.get('u2')).toBeUndefined();
  });

  it('lets a non-operator create a user without a tools map', async () => {
    const { context, collective } = await makeContext(caller({ id: 'u1', operator: false }));
    const result = await createUserTool.execute({ id: 'u2', name: 'U2' }, context);
    expect(result.status).toBe('success');
    expect((collective.get('u2') as UserConfig).tools).toEqual(SUBSCRIPTION_TOOLS);
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
    expect((collective.get('alice') as UserConfig).tools).toEqual({
      ...SUBSCRIPTION_TOOLS,
      communicate: 'auto',
    });
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

  it('refuses self-promotion to operator unless the caller is an operator', async () => {
    const { context, collective } = await makeContext(caller({ id: 'u1', operator: false }));
    await createUserTool.execute({ id: 'u1', name: 'U1' }, context);
    const result = await modifyUserTool.execute({ id: 'u1', operator: true }, context);
    expect(result.status).toBe('error');
    expect(result.error).toContain('operator');
    expect((collective.get('u1') as UserConfig).operator).toBeUndefined();
  });

  it('refuses to demote an operator unless the caller is an operator', async () => {
    const { context, collective } = await makeContext(caller({ id: 'u1', operator: false }));
    // Keep a second operator so the collective's last-operator invariant does not
    // mask the privilege guard being tested here.
    await collective.add({
      id: 'other-op',
      name: 'Other Operator',
      type: 'user',
      tools: {},
      operator: true,
    });
    const result = await modifyUserTool.execute({ id: 'operator', operator: false }, context);
    expect(result.status).toBe('error');
    expect(result.error).toContain('operator');
    expect((collective.get('operator') as UserConfig).operator).toBe(true);
  });

  it('allows an operator to promote another user', async () => {
    const { context, collective } = await makeContext();
    await createUserTool.execute({ id: 'alice', name: 'Alice' }, context);
    const result = await modifyUserTool.execute({ id: 'alice', operator: true }, context);
    expect(result.status).toBe('success');
    expect((collective.get('alice') as UserConfig).operator).toBe(true);
  });

  it('lets a non-operator rename a user without touching the operator flag', async () => {
    const { context, collective } = await makeContext(caller({ id: 'u1', operator: false }));
    await createUserTool.execute({ id: 'u2', name: 'U2' }, context);
    const result = await modifyUserTool.execute({ id: 'u2', name: 'U2 renamed' }, context);
    expect(result.status).toBe('success');
    expect((collective.get('u2') as UserConfig).name).toBe('U2 renamed');
  });

  it('refuses a non-operator self-granting save_mcp_sources via modify_user', async () => {
    // Regression for the critical review finding: modify_user accepted `tools`
    // verbatim, so a non-operator with modify_user could grant itself
    // save_mcp_sources (arbitrary command execution on the next boot).
    const { context: nonOperatorContext, collective } = await makeContext(
      caller({ id: 'u1', operator: false }),
    );
    await createUserTool.execute({ id: 'u1', name: 'U1' }, nonOperatorContext);
    const result = await modifyUserTool.execute(
      { id: 'u1', tools: { save_mcp_sources: 'auto' } },
      nonOperatorContext,
    );
    expect(result.status).toBe('error');
    expect(result.error).toContain('tool polic');
    // The pre-existing policy map is untouched.
    expect((collective.get('u1') as UserConfig).tools).toEqual(SUBSCRIPTION_TOOLS);
  });

  it('lets an operator replace tools through modify_user', async () => {
    const { context, collective } = await makeContext();
    await createUserTool.execute({ id: 'alice', name: 'Alice' }, context);
    const result = await modifyUserTool.execute(
      { id: 'alice', tools: { save_mcp_sources: 'auto' } },
      context,
    );
    expect(result.status).toBe('success');
    expect((collective.get('alice') as UserConfig).tools).toEqual({ save_mcp_sources: 'auto' });
  });
});
