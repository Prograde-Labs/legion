import { RuntimeRegistry } from './RuntimeRegistry.js';
import type { Runtime } from './Runtime.js';

const stubRuntime: Runtime = {
  async handle() {
    return 'ok';
  },
};

describe('RuntimeRegistry', () => {
  it('registers a factory per participant type and builds runtimes', () => {
    const reg = new RuntimeRegistry();
    reg.registerFactory('mock', () => stubRuntime);
    expect(reg.has('mock')).toBe(true);
    expect(reg.build('mock', 'mock-1')).toBe(stubRuntime);
  });

  it('throws building a runtime for an unregistered type', () => {
    const reg = new RuntimeRegistry();
    expect(() => reg.build('agent', 'agent-1')).toThrow(/no runtime factory/i);
  });

  it('rejects duplicate factory registration', () => {
    const reg = new RuntimeRegistry();
    reg.registerFactory('mock', () => stubRuntime);
    expect(() => reg.registerFactory('mock', () => stubRuntime)).toThrow(/already/i);
  });
});
