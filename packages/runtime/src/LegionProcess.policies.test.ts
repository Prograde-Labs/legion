import { describe, expect, it } from 'vitest';
import { Collective, MemoryStorage } from '@legion-collective/core';
import type { UserConfig } from '@legion-collective/types';
import { ensureBootstrapRuntimeToolPolicies } from './LegionProcess.js';

async function makeCollective(): Promise<Collective> {
  const collective = await Collective.load(new MemoryStorage());
  await collective.seedDefaultsIfEmpty();
  return collective;
}

describe('ensureBootstrapRuntimeToolPolicies', () => {
  it('grants the read/subscription tools every user needs to be live', async () => {
    const collective = await makeCollective();
    await collective.add({
      id: 'approver',
      name: 'Approver',
      type: 'user',
      tools: { communicate: 'auto' },
      status: 'active',
    });

    await ensureBootstrapRuntimeToolPolicies(collective);

    const approver = collective.get('approver') as UserConfig;
    // cancel_stream lets the thread stop/restart its stream on a conversation
    // switch; ownership is enforced by StreamRegistry.cancelForParticipant.
    expect(approver.tools['cancel_stream']).toBe('auto');
    expect(approver.tools['watch_activity']).toBe('auto');
    expect(approver.tools['watch_conversation']).toBe('auto');
    expect(approver.tools['watch_conversations']).toBe('auto');
    expect(approver.tools['list_pending_approvals']).toBe('auto');
    // Existing policies are preserved.
    expect(approver.tools['communicate']).toBe('auto');
    // Privilege-bearing runtime tools are not granted to non-operators.
    expect(approver.tools['save_mcp_sources']).toBeUndefined();
    expect(approver.tools['save_provider']).toBeUndefined();
    expect(approver.tools['set_secret']).toBeUndefined();
  });

  it('keeps the operator runtime tool set and is idempotent', async () => {
    const collective = await makeCollective();
    await ensureBootstrapRuntimeToolPolicies(collective);
    const first = collective.get('operator') as UserConfig;

    await ensureBootstrapRuntimeToolPolicies(collective);
    const second = collective.get('operator') as UserConfig;

    expect(second.tools['save_provider']).toBe('auto');
    expect(second.tools['save_mcp_sources']).toBe('auto');
    expect(second.tools['watch_activity']).toBe('auto');
    expect(second.tools).toEqual(first.tools);
  });

  it('migrates missing Codex tools without changing explicitly configured policies', async () => {
    const collective = await makeCollective();
    await ensureBootstrapRuntimeToolPolicies(collective);
    const operator = collective.get('operator') as UserConfig;
    const tools = { ...operator.tools };
    const names = [
      'openai_login_start',
      'openai_login_poll',
      'openai_auth_status',
      'openai_logout',
      'openai_usage',
    ];
    for (const name of names) delete tools[name];
    tools['openai_logout'] = 'requires_approval';
    await collective.update('operator', { tools });

    await ensureBootstrapRuntimeToolPolicies(collective);

    const migrated = (collective.get('operator') as UserConfig).tools;
    expect(migrated).toEqual({
      ...tools,
      openai_login_start: 'auto',
      openai_login_poll: 'auto',
      openai_auth_status: 'auto',
      openai_usage: 'auto',
    });
  });
});
