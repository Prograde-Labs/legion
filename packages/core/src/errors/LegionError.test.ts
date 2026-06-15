import {
  LegionError,
  ParticipantNotFoundError,
  ToolNotFoundError,
  ProviderError,
  ConfigError,
} from './LegionError.js';

describe('LegionError', () => {
  it('is an Error subclass carrying a stable code', () => {
    const err = new LegionError('boom', 'LEGION_ERROR');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('LegionError');
    expect(err.code).toBe('LEGION_ERROR');
    expect(err.message).toBe('boom');
  });

  it('ParticipantNotFoundError includes the id and a specific code', () => {
    const err = new ParticipantNotFoundError('agent-7');
    expect(err).toBeInstanceOf(LegionError);
    expect(err.name).toBe('ParticipantNotFoundError');
    expect(err.code).toBe('PARTICIPANT_NOT_FOUND');
    expect(err.message).toContain('agent-7');
  });

  it('ToolNotFoundError includes the tool name', () => {
    const err = new ToolNotFoundError('communicate');
    expect(err.code).toBe('TOOL_NOT_FOUND');
    expect(err.message).toContain('communicate');
  });

  it('ProviderError and ConfigError carry their own codes', () => {
    expect(new ProviderError('rate limited').code).toBe('PROVIDER_ERROR');
    expect(new ConfigError('bad config').code).toBe('CONFIG_ERROR');
  });
});
