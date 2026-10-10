import { MemoryStorage } from '../storage/MemoryStorage.js';
import { Collective } from '../collective/Collective.js';
import { createUserTool } from './user-tools.js';
import { setApprovalAuthorityTool } from './approval-authority-tool.js';
import { createAgentTool } from './management-tools.js';
import type { ToolContext } from './Tool.js';
import type { AgentConfig, UserConfig } from '@legion-collective/types';

async function makeContext(): Promise<{ context: ToolContext; collective: Collective }> {
  const storage = new MemoryStorage();
  const collective = await Collective.load(storage);
  await collective.seedDefaultsIfEmpty();
  const context = { collective } as unknown as ToolContext;
  return { context, collective };
}

describe('set_approval_authority', () => {
  it('sets a wildcard authority on a user', async () => {
    const { context, collective } = await makeContext();
    await createUserTool.execute({ id: 'alice', name: 'Alice' }, context);
    const result = await setApprovalAuthorityTool.execute(
      { participantId: 'alice', authority: { tools: '*', participants: '*' } },
      context,
    );
    expect(result.status).toBe('success');
    expect((collective.get('alice') as UserConfig).approvalAuthority).toEqual({
      tools: '*',
      participants: '*',
    });
  });

  it('sets a scoped authority on an agent', async () => {
    const { context, collective } = await makeContext();
    await createAgentTool.execute(
      { id: 'bot', name: 'Bot', systemPrompt: 'p', model: { model: 'm' } },
      context,
    );
    const result = await setApprovalAuthorityTool.execute(
      {
        participantId: 'bot',
        authority: { tools: { communicate: true }, participants: ['alice'] },
      },
      context,
    );
    expect(result.status).toBe('success');
    expect((collective.get('bot') as AgentConfig).approvalAuthority).toEqual({
      tools: { communicate: true },
      participants: ['alice'],
    });
  });

  it('clears authority with null', async () => {
    const { context, collective } = await makeContext();
    await createUserTool.execute({ id: 'alice', name: 'Alice' }, context);
    await setApprovalAuthorityTool.execute(
      { participantId: 'alice', authority: { tools: '*' } },
      context,
    );
    const result = await setApprovalAuthorityTool.execute(
      { participantId: 'alice', authority: null },
      context,
    );
    expect(result.status).toBe('success');
    expect((collective.get('alice') as UserConfig).approvalAuthority).toBeFalsy();
  });

  it('rejects unknown participants', async () => {
    const { context } = await makeContext();
    const result = await setApprovalAuthorityTool.execute(
      { participantId: 'ghost', authority: { tools: '*' } },
      context,
    );
    expect(result.status).toBe('error');
  });

  it('rejects malformed authority objects', async () => {
    const { context } = await makeContext();
    await createUserTool.execute({ id: 'alice', name: 'Alice' }, context);
    const result = await setApprovalAuthorityTool.execute(
      { participantId: 'alice', authority: { bogus: true } },
      context,
    );
    expect(result.status).toBe('error');
    expect(result.error).toContain('authority');
  });
});
