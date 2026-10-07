import { describe, it, expect } from 'vitest';
import { OpenAIResponsesProvider } from './OpenAIResponsesProvider.js';

const LIVE = !!process.env['LEGION_OPENAI_RESPONSES_INTEGRATION'];
const BASE_URL = process.env['OPENAI_RESPONSES_BASE_URL'] ?? 'https://api.openai.com/v1';
const MODEL_ID = process.env['OPENAI_RESPONSES_MODEL'] ?? 'gpt-4o-mini';

describe.skipIf(!LIVE)('OpenAIResponsesProvider: live backend', () => {
  it('streams one text turn end-to-end', async () => {
    const apiKey = process.env['OPENAI_API_KEY'];
    if (!apiKey) throw new Error('OPENAI_API_KEY is required when the integration gate is on');

    const provider = new OpenAIResponsesProvider(BASE_URL, apiKey);
    const chunks = [];
    for await (const chunk of provider.stream(
      [
        { role: 'system', content: 'Always respond in exactly one short sentence.' },
        { role: 'user', content: 'Say hello.' },
      ],
      [],
      { model: MODEL_ID },
    )) {
      chunks.push(chunk);
    }

    const done = chunks.at(-1);
    expect(done?.type).toBe('done');
    const text = chunks
      .filter((c) => c.type === 'text_delta')
      .map((c) => c.delta)
      .join('');
    expect(text.length).toBeGreaterThan(0);
    if (done?.type === 'done') {
      expect(done.stopReason).toBe('stop');
    }
  });
});
