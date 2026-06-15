import type { MessageData, MockConfig } from '@legion/types';
import type { Runtime, RuntimeContext } from './Runtime.js';

export class MockRuntime implements Runtime {
  private index = 0;

  constructor(private participantId: string) {}

  async handle(_incoming: MessageData, context: RuntimeContext): Promise<string> {
    const participant = context.collective.getOrThrow(this.participantId);
    const responses = participant.type === 'mock' ? (participant as MockConfig).responses : [];
    if (responses.length === 0) {
      return `[mock:${this.participantId}] no scripted response`;
    }
    const response = responses[this.index % responses.length];
    this.index += 1;
    return response;
  }
}
