import { ProviderRegistry } from './ProviderRegistry.js';
import type { Provider } from './Provider.js';

const stubProvider: Provider = {
  async complete() {
    return { content: 'ok', toolCalls: [], stopReason: 'stop' };
  },
};

describe('ProviderRegistry', () => {
  it('registers and retrieves a provider by name', () => {
    const reg = new ProviderRegistry();
    reg.register('openai-compatible', stubProvider);
    expect(reg.has('openai-compatible')).toBe(true);
    expect(reg.get('openai-compatible')).toBe(stubProvider);
  });

  it('returns undefined for an unregistered name', () => {
    const reg = new ProviderRegistry();
    expect(reg.get('anthropic')).toBeUndefined();
    expect(reg.has('anthropic')).toBe(false);
  });

  it('rejects duplicate registration', () => {
    const reg = new ProviderRegistry();
    reg.register('openai-compatible', stubProvider);
    expect(() => reg.register('openai-compatible', stubProvider)).toThrow(/already registered/i);
  });
});
