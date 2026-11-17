import { basename, dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CodexAuthStore } from './CodexAuthStore.js';
import { CodexProvider } from './CodexProvider.js';

const LIVE = process.env['LEGION_OPENAI_CODEX_INTEGRATION'] === '1';
const AUTH_FILE = process.env['LEGION_CODEX_AUTH_FILE'];
const MODEL_ID = process.env['LEGION_CODEX_MODEL'] ?? 'gpt-5.5';

function makeProvider(): CodexProvider {
  if (!AUTH_FILE) throw new Error('LEGION_CODEX_AUTH_FILE is required');
  const providerName = basename(AUTH_FILE, '.json');
  return new CodexProvider(
    { name: providerName, type: 'codex', priority: 10 },
    new CodexAuthStore(dirname(AUTH_FILE)),
  );
}

describe.skipIf(!LIVE)('CodexProvider: live backend', () => {
  it('streams one text turn end-to-end', async () => {
    const provider = makeProvider();
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
      expect(done.cost).toBe(0);
    }
  });

  it('calls a function tool', async () => {
    const provider = makeProvider();
    const chunks = [];
    for await (const chunk of provider.stream(
      [{ role: 'user', content: 'Call the echo tool with the message hi.' }],
      [
        {
          name: 'echo',
          description: 'Echo a message back.',
          parameters: {
            type: 'object',
            properties: { message: { type: 'string' } },
            required: ['message'],
          },
        },
      ],
      { model: MODEL_ID },
    )) {
      chunks.push(chunk);
    }

    expect(chunks.some((c) => c.type === 'tool_call_start')).toBe(true);
  });

  it('fetches plan usage', async () => {
    const provider = makeProvider();
    const usage = await provider.usage();
    expect(Array.isArray(usage.windows)).toBe(true);
    expect(usage.capturedAt).toBeTruthy();
  });
});
