import { createDefaultParticipants, BOOTSTRAP_OPERATOR_ID } from './default-participants.js';

describe('createDefaultParticipants', () => {
  it('produces a protected operator user with broad authority', () => {
    const [operator] = createDefaultParticipants();
    expect(operator.id).toBe(BOOTSTRAP_OPERATOR_ID);
    expect(operator.type).toBe('user');
    expect(operator.operator).toBe(true);
    expect(operator.protected).toBe(true);
    expect(operator.approvalAuthority?.tools).toBe('*');
    expect(operator.approvalAuthority?.participants).toBe('*');
  });

  it('grants the operator the web connector identity and management tools', () => {
    const [operator] = createDefaultParticipants();
    expect(operator.identities).toEqual([{ connector: 'web', externalId: BOOTSTRAP_OPERATOR_ID }]);
    expect(operator.tools['create_agent']).toBe('auto');
    expect(operator.tools['communicate']).toBe('auto');
    expect(operator.tools['approval_response']).toBe('auto');
    expect(operator.tools['set_tool_policy']).toBe('auto');
    expect(operator.tools['remove_tool_policy']).toBe('auto');
    expect(operator.tools['save_provider']).toBe('auto');
    expect(operator.tools['delete_provider']).toBe('auto');
    expect(operator.tools['list_models']).toBe('auto');
    expect(operator.tools['get_routing']).toBe('auto');
    expect(operator.tools['save_routing']).toBe('auto');
    expect(operator.tools['configure_provider']).toBeUndefined();
    expect(operator.tools['list_credentials']).toBeUndefined();
    expect(operator.tools['set_credential_with_meta']).toBeUndefined();
  });
});
