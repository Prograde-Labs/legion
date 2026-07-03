import MarkdownIt from 'markdown-it';
import { fromHighlighter } from '@shikijs/markdown-it';
import DOMPurify from 'dompurify';
import { createHighlighter, createJavaScriptRegexEngine } from 'shiki';

let _md: MarkdownIt | null = null;
let _initPromise: Promise<void> | null = null;

export function ensureReady(): Promise<void> {
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    try {
      const highlighter = await createHighlighter({
        themes: ['github-dark'],
        langs: [
          'typescript',
          'javascript',
          'python',
          'bash',
          'shell',
          'json',
          'yaml',
          'html',
          'css',
          'markdown',
          'sql',
        ],
        engine: createJavaScriptRegexEngine(),
      });

      const md = new MarkdownIt({
        html: false,
        linkify: true,
        typographer: true,
        breaks: true,
      });

      md.use(fromHighlighter(highlighter, { theme: 'github-dark' }));

      // Wrap Shiki's fence output with a .code-block div + copy button.
      // This must happen AFTER fromHighlighter() replaces the fence rule.
      const shikiFence = md.renderer.rules['fence'];
      if (shikiFence) {
        md.renderer.rules['fence'] = (...args) => {
          const shikiHtml = shikiFence(...args);
          return `<div class="code-block">${shikiHtml}<button type="button" class="copy-btn" data-copy-code>Copy</button></div>`;
        };
      }

      _md = md;
    } catch (err) {
      // Initialisation failed - render() will fall back to escaped plain text.
      console.error('[markdown] Failed to initialise Shiki:', err);
    }
  })();

  return _initPromise;
}

const ESC: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(str: string): string {
  return str.replace(/[&<>"']/g, (c) => ESC[c] ?? c);
}

export function render(content: string): string {
  if (!_md) {
    // Fallback: plain escaped text before init completes (or if init failed).
    return `<p>${escapeHtml(content)}</p>`;
  }

  return DOMPurify.sanitize(_md.render(content), {
    USE_PROFILES: { html: true },
    ALLOW_DATA_ATTR: true,
    SANITIZE_NAMED_PROPS: true,
  });
}
