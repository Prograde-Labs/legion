import { describe, expect, it } from 'vitest';
import { ensureReady, render } from './markdown';

describe('markdown', () => {
  it('does not throw for unloaded fence languages', async () => {
    const content = '```foobar\n<script>alert(1)</script>\n```';

    await ensureReady();

    const html = render(content);

    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
  });
});
