import { describe, expect, it } from 'vitest';
import { ensureReady, render } from './markdown';

describe('markdown', () => {
  it('renders unloaded fence languages as safe copyable code blocks', async () => {
    const content = '**before**\n\n```foobar\n<script>alert(1)</script>\n```';

    await ensureReady();

    const html = render(content);

    expect(html).toContain('<strong>before</strong>');
    expect(html).toContain('class="code-block"');
    expect(html).toContain('data-copy-code');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('ampersands in unknown fence code blocks display correctly', async () => {
    const content = '```foobar\nfoo && bar\n```';

    await ensureReady();

    const html = render(content);

    // DOMPurify round-trips through the DOM, so we need double-escaping;
    // verify the output contains properly encoded ampersands
    expect(html).toContain('&amp;&amp;');
    expect(html).not.toContain('&&amp;');
    expect(html).not.toContain('&amp;amp;');
  });
});
