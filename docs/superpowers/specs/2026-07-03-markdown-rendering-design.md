# Markdown Rendering — Design Spec

**Date:** 2026-07-03
**Status:** Approved

## Goal

Add markdown rendering with syntax-highlighted code blocks to every message bubble in the conversation interface. Currently all message content renders as plain text via Vue mustache interpolation. After this change, rich markdown (headings, lists, bold/italic, blockquotes, inline code, fenced code blocks with syntax highlighting) will be rendered as HTML in all bubble contexts.

## Background

The conversation UI has two places where message content is displayed:

- `MessageBubble.vue` — the primary chat bubble used in `ConversationThread.vue` (chat mode)
- `SubThreadBlock.vue` — the nested agent-to-agent message list rendered inside `ToolCallBlock.vue` expansions

Both currently render content as `{{ content }}` — plain text with `whitespace-pre-wrap`. Neither has any markdown or HTML rendering capability.

## Approach

### Library Stack

Three packages are added; all have been risk-assessed.

| Package | Role | Risk assessment |
|---|---|---|
| `markdown-it` v14 | Markdown → HTML parser | Low. HTML disabled by default, 100% CommonMark compliant, actively maintained (last publish: 2 days ago), 11-year track record. Single maintainer is the only risk flag. |
| `shiki` + `@shikijs/markdown-it` | Syntax highlighting | Low. Published today (v4.3.1). Maintained by Anthony Fu (Vite/VitePress/UnoCSS core team). Used by VitePress — Vue's own docs framework — in production. VS Code-quality TextMate grammars. Inline style tokens (no external CSS file). `createJavaScriptRegexEngine()` eliminates the WASM dependency. |
| `dompurify` | HTML sanitization | Low. Maintained by cure53 (professional security research firm), 46M weekly downloads, last published 16 days ago, zero runtime dependencies, 10 KB gzip. |

**Rejected alternatives:**
- `marked` — unsafe defaults (HTML pass-through); 18 historical CVEs; requires mandatory sanitization everywhere or XSS risk.
- `highlight.js` — 2-year npm publish gap; 107 open PRs; requires external CSS file; no first-party markdown-it plugin.
- `lowlight` — sole maintainer, 19 months stale, wraps highlight.js with no added value for Vue 3.
- `isomorphic-dompurify` — only needed for SSR. This is a client-side SPA; bare DOMPurify is sufficient.
- `@tailwindcss/typography` — Tailwind v4 plugin API changed significantly; compatibility uncertain. Custom styles give full control over the navy palette.

### Architecture

#### New: `src/lib/markdown.ts`

A module-level singleton (not a Vue composable — this is a rendering/lifecycle concern, not a data/service concern). Holds the initialized `markdown-it` instance with Shiki wired in. Exports:

```ts
export async function ensureReady(): Promise<void>
export function render(content: string): string
```

`ensureReady()` is idempotent — it initializes on the first call and is a no-op on all subsequent calls. Multiple `MarkdownContent` instances calling it concurrently share the same initialization promise; Shiki is only created once.

`render()` calls `md.render(content)` then `DOMPurify.sanitize()` and returns the resulting HTML string.

#### New: `src/components/MarkdownContent.vue`

The single reusable component for all markdown rendering in the app. Owns both the Shiki lifecycle and the rendering pipeline.

```
Props:   content: string
Attrs:   passed through to root div (class, style, etc.)
```

On mount, calls `ensureReady()`. Before ready, renders escaped plain text as a fallback (in practice a sub-200ms window on first load; all subsequent mounts are instant). After ready, renders `v-html` with the processed HTML.

Styling is intentionally not owned by this component — no hardcoded colors or font sizes. The parent sets the visual context (bubble background, text color, font size) via normal class passthrough. `MarkdownContent` applies only structural markdown styles via the `.md-content` CSS class.

The component handles copy button clicks via event delegation on its root element — no `v-html` content ever needs reactive handlers.

#### Modified: `MessageBubble.vue`

Replace:
```html
{{ message.content?.trim() }}
```
With:
```html
<MarkdownContent :content="message.content?.trim() ?? ''" />
```

Remove `whitespace-pre-wrap` (markdown-it handles whitespace). The `v-if` guard on blank content remains.

#### Modified: `SubThreadBlock.vue`

Replace:
```html
<p class="text-[11px] text-slate-300 leading-relaxed">{{ msg.content }}</p>
```
With:
```html
<MarkdownContent :content="msg.content" class="text-[11px] text-slate-300 leading-relaxed" />
```

#### Modified: `src/assets/style.css`

Add `.md-content` prose styles. Structural only — margins, list indentation, blockquote border, heading weight. No colors or font sizes (those are inherited from the parent context). Special cases:

- `pre.shiki` — `border-radius`, `overflow-x: auto`, relative positioning for the copy button container
- Inline code (`code` not inside `pre`) — semi-transparent darker background readable against both navy-800 and cyan-700 bubble backgrounds
- Links — `color: inherit` + underline decoration
- Tables — collapsed borders, padded cells

`main.ts` is **not modified** — initialization is triggered by the first `MarkdownContent` mount.

### Rendering Pipeline

```
raw message content
  → markdown-it.render()
      (parses markdown AST → HTML)
      (Shiki plugin intercepts fenced code blocks → injects inline-styled token spans)
  → DOMPurify.sanitize({ USE_PROFILES: { html: true }, SANITIZE_NAMED_PROPS: true })
      (removes any unexpected HTML that passed through; belt-and-suspenders)
  → v-html binding on MarkdownContent root div
```

### Shiki Configuration

```ts
createHighlighter({
  themes: ['github-dark'],
  langs: [
    'typescript', 'javascript', 'python',
    'bash', 'shell', 'json', 'yaml',
    'html', 'css', 'markdown', 'sql',
  ],
  engine: createJavaScriptRegexEngine(), // no WASM
})
```

**Theme: `github-dark`** — selected for its neutral, high-contrast dark palette that complements the navy UI without competing with it.

Languages can be extended by adding entries to this array; no other changes required.

### Copy Button

Shiki's `postprocess` hook wraps each rendered `<pre>` in a `<div class="code-block relative">` with an injected `<button data-copy-code>Copy</button>` positioned top-right.

`MarkdownContent.vue` listens for clicks on its root element:

```ts
function onRootClick(e: MouseEvent) {
  const btn = (e.target as HTMLElement).closest('[data-copy-code]')
  if (!btn) return
  const code = btn.closest('.code-block')?.querySelector('pre')?.textContent ?? ''
  navigator.clipboard.writeText(code).then(() => {
    btn.textContent = 'Copied!'
    setTimeout(() => { btn.textContent = 'Copy' }, 2000)
  }).catch(() => {
    btn.textContent = 'Copy' // silent failure — permissions denied
  })
}
```

No additional library required. Clipboard API is supported in all modern browsers.

## Error Handling

| Scenario | Behaviour |
|---|---|
| Shiki init fails (e.g. runtime error) | `ensureReady()` catches and swallows the error; `render()` falls back to HTML-escaped plain text permanently. No crash, no broken UI. |
| `md.render()` throws | Not expected — markdown-it is resilient to all input. If it does throw, `MarkdownContent` catches and renders escaped plain text. |
| `navigator.clipboard` rejects | Copy button silently resets to "Copy" label. No error surfaced to the user. |

## Testing

Two new e2e scenarios added to `packages/e2e/`:

1. **Markdown renders as HTML** — send a message containing markdown (bold, a list, a fenced code block). Assert that the bubble contains `<strong>`, `<ul>`, and `<pre class="shiki">` elements — not literal asterisks or backticks.
2. **Copy button** — find a code block's copy button, click it, read `navigator.clipboard` content, assert it matches the raw code text.

No unit tests for the markdown rendering pipeline itself — markdown-it and Shiki are well-tested upstream; testing their wiring would be testing their libraries rather than our code.

## Files Changed

| File | Change |
|---|---|
| `packages/web/package.json` | Add `markdown-it`, `shiki`, `@shikijs/markdown-it`, `dompurify`; add `@types/markdown-it`, `@types/dompurify` to devDeps |
| `packages/web/src/lib/markdown.ts` | **New** — singleton init + render function |
| `packages/web/src/components/MarkdownContent.vue` | **New** — reusable markdown rendering component |
| `packages/web/src/components/conversations/MessageBubble.vue` | Replace plain text interpolation with `<MarkdownContent>` |
| `packages/web/src/components/conversations/SubThreadBlock.vue` | Replace plain text interpolation with `<MarkdownContent>` |
| `packages/web/src/assets/style.css` | Add `.md-content` prose styles and copy button styles |
| `packages/e2e/` | Two new test scenarios |
