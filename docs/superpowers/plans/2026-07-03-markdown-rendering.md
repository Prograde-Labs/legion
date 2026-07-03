# Markdown Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add markdown rendering with syntax-highlighted code blocks and a copy button to every message bubble in the conversation interface.

**Architecture:** A module-level singleton (`src/lib/markdown.ts`) initialises markdown-it + Shiki once on first use. A new `MarkdownContent.vue` component owns the lifecycle (calling `ensureReady()` on mount) and rendering pipeline (`render()` → `v-html`), receiving styling from parents via class passthrough. `MessageBubble.vue` and `SubThreadBlock.vue` swap their plain-text interpolations for `<MarkdownContent>`.

**Tech Stack:** `markdown-it` (parser), `shiki` + `@shikijs/markdown-it` (syntax highlighting, github-dark theme, JS regex engine — no WASM), `dompurify` (sanitization), Playwright e2e tests.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `packages/web/package.json` | Modify | Add runtime + dev dependencies |
| `packages/web/src/lib/markdown.ts` | **Create** | Module singleton: Shiki + markdown-it init, `ensureReady()`, `render()` |
| `packages/web/src/components/MarkdownContent.vue` | **Create** | Reusable rendering component: lifecycle, `v-html`, copy-button event delegation |
| `packages/web/src/assets/style.css` | Modify | Add `.md-content` prose styles + code block / copy button styles |
| `packages/web/src/components/conversations/MessageBubble.vue` | Modify | Swap `{{ content }}` for `<MarkdownContent>` |
| `packages/web/src/components/conversations/SubThreadBlock.vue` | Modify | Swap `{{ msg.content }}` for `<MarkdownContent>` |
| `packages/e2e/tests/conversations/markdown.spec.ts` | **Create** | E2e: markdown renders as HTML; copy button writes correct text |

---

## Task 1: Install dependencies

**Files:**
- Modify: `packages/web/package.json`

- [ ] **Step 1: Add packages**

Run from `packages/web/`:

```bash
npm install markdown-it shiki @shikijs/markdown-it dompurify
npm install -D @types/markdown-it @types/dompurify
```

- [ ] **Step 2: Verify the build still passes**

```bash
npm run build
```

Expected: build succeeds with no TypeScript errors. If `@types/markdown-it` or `@types/dompurify` cause issues, check that they are in `devDependencies`, not `dependencies`.

- [ ] **Step 3: Commit**

```bash
git add packages/web/package.json package-lock.json
git commit -m "chore(web): add markdown-it, shiki, dompurify dependencies"
```

---

## Task 2: Write failing e2e tests

**Files:**
- Create: `packages/e2e/tests/conversations/markdown.spec.ts`

Write these tests first — they will fail until the implementation is in place. That's the point.

- [ ] **Step 1: Create the test file**

```typescript
// packages/e2e/tests/conversations/markdown.spec.ts
import { test, expect } from '../../fixtures/index.js';

test.describe('Markdown rendering in message bubbles', () => {
  let agentId: string;

  test.beforeAll(async ({ api, connInfo }) => {
    const { token } = await api.login('operator', connInfo.password);

    await api.execute(token, 'set_credential_with_meta', {
      key: 'md-test-cred',
      value: 'sk-mock',
      usedBy: [],
    });
    await api.execute(token, 'configure_provider', {
      name: 'md-test-provider',
      type: 'openai-compatible',
      baseUrl: connInfo.mockProviderUrl,
      defaultModel: 'mock-model',
      credentialKey: 'md-test-cred',
    });

    const createResult = await api.execute<{ id: string }>(token, 'create_agent', {
      id: `md-test-agent-${Date.now()}`,
      name: 'md-test-agent',
      systemPrompt: 'test agent for markdown rendering',
      model: { provider: 'md-test-provider', model: 'mock-model' },
    });
    expect(createResult.result.status).toBe('success');
    agentId = createResult.result.data!.id;
  });

  test('bold markdown in user message renders as <strong>, not raw **', async ({ authPage, api }) => {
    const { page, token } = authPage;

    const commResult = await api.execute<{ conversationId: string }>(token, 'communicate', {
      to: agentId,
      message: '**bold text** and `inline code`',
    });
    expect(commResult.result.status).toBe('success');
    const conversationId = commResult.result.data!.conversationId;

    await page.goto(`/#/conversations/${conversationId}`);

    // Wait for chat mode to kick in (conversations load async; chat mode shows [data-bubble])
    await page.waitForSelector('[data-bubble]', { timeout: 8000 });

    // Some bubble must contain a <strong> element
    await expect(page.locator('[data-bubble] strong').first()).toBeVisible();

    // No bubble should contain the raw markdown asterisks
    await expect(page.locator('[data-bubble]').first()).not.toContainText('**bold text**');
  });

  test('fenced code block in user message renders with copy button that writes correct text', async ({ authPage, api }) => {
    const { page, token } = authPage;

    // Spy on clipboard.writeText before any navigation
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>)['__clipboardData'] = '';
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          writeText: (text: string): Promise<void> => {
            (window as unknown as Record<string, unknown>)['__clipboardData'] = text;
            return Promise.resolve();
          },
        },
        configurable: true,
        writable: true,
      });
    });

    const commResult = await api.execute<{ conversationId: string }>(token, 'communicate', {
      to: agentId,
      message: 'Here is some code:\n```typescript\nconst x: number = 42;\n```',
    });
    expect(commResult.result.status).toBe('success');
    const conversationId = commResult.result.data!.conversationId;

    await page.goto(`/#/conversations/${conversationId}`);

    // Wait for the code block copy button to appear
    await page.waitForSelector('[data-copy-code]', { timeout: 8000 });

    await page.locator('[data-copy-code]').first().click();

    const copied = await page.evaluate(
      () => (window as unknown as Record<string, unknown>)['__clipboardData'] as string
    );
    expect(copied.trim()).toContain('const x: number = 42;');
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Start the Legion server in a separate terminal first (the e2e suite needs a running server — see `packages/e2e/README.md`), then:

```bash
npx playwright test tests/conversations/markdown.spec.ts --reporter=list
```

Run from `packages/e2e/`.

Expected: both tests fail. The first test fails because `[data-bubble] strong` is not found (markdown is rendered as raw `**bold text**`). The second test fails because `[data-copy-code]` is not found (no copy button exists).

If the tests fail for a different reason (server not reachable, auth error), fix that before proceeding.

- [ ] **Step 3: Commit the failing tests**

```bash
git add packages/e2e/tests/conversations/markdown.spec.ts
git commit -m "test(e2e): add failing markdown rendering tests"
```

---

## Task 3: Create `src/lib/markdown.ts`

**Files:**
- Create: `packages/web/src/lib/markdown.ts`

- [ ] **Step 1: Create the `lib/` directory and the file**

```typescript
// packages/web/src/lib/markdown.ts
import MarkdownIt from 'markdown-it';
import { createHighlighter, createJavaScriptRegexEngine } from 'shiki';
import { fromHighlighter } from '@shikijs/markdown-it';
import DOMPurify from 'dompurify';

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
      // Initialisation failed — render() will fall back to escaped plain text.
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
    ALLOW_DATA_ATTR: true,   // preserve data-copy-code on the button
    SANITIZE_NAMED_PROPS: true,
  });
}
```

- [ ] **Step 2: Verify TypeScript is happy**

```bash
npm run build
```

Run from `packages/web/`. Expected: no errors. If `createJavaScriptRegexEngine` is not found as a named export from `shiki`, check the Shiki v4 docs — it may be at `shiki/engine/javascript`:

```typescript
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
```

If `fromHighlighter` import path is wrong, check the `@shikijs/markdown-it` README — it may be the default export:

```typescript
import fromHighlighter from '@shikijs/markdown-it';
```

Fix whichever import doesn't resolve and re-run build.

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/lib/markdown.ts
git commit -m "feat(web): add markdown singleton lib (markdown-it + shiki + dompurify)"
```

---

## Task 4: Create `MarkdownContent.vue`

**Files:**
- Create: `packages/web/src/components/MarkdownContent.vue`

- [ ] **Step 1: Create the component**

```vue
<!-- packages/web/src/components/MarkdownContent.vue -->
<script setup lang="ts">
import { ref, computed } from 'vue';
import { ensureReady, render } from '../lib/markdown.js';

const props = defineProps<{ content: string }>();

// ready flips to true when ensureReady() resolves.
// The computed below reads it to establish a reactive dependency,
// so the rendered HTML re-evaluates once Shiki is available.
const ready = ref(false);
ensureReady().then(() => {
  ready.value = true;
});

const rendered = computed(() => {
  void ready.value; // establish dependency
  return render(props.content);
});

function onRootClick(e: MouseEvent): void {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-copy-code]');
  if (!btn) return;

  const pre = btn.closest('.code-block')?.querySelector('pre');
  if (!pre) return;

  const text = pre.textContent ?? '';
  navigator.clipboard.writeText(text).then(() => {
    btn.textContent = 'Copied!';
    setTimeout(() => {
      btn.textContent = 'Copy';
    }, 2000);
  }).catch(() => {
    btn.textContent = 'Copy';
  });
}
</script>

<template>
  <!-- class="md-content" provides prose styles; parent classes are passed through via inheritAttrs -->
  <div class="md-content" v-html="rendered" @click="onRootClick" />
</template>
```

- [ ] **Step 2: Verify TypeScript is happy**

```bash
npm run build
```

Run from `packages/web/`. Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/components/MarkdownContent.vue
git commit -m "feat(web): add MarkdownContent component with Shiki lifecycle and copy button"
```

---

## Task 5: Add `.md-content` prose styles

**Files:**
- Modify: `packages/web/src/assets/style.css`

- [ ] **Step 1: Append the styles**

Add the following after the existing `@theme` block in `style.css`:

```css
/* ─── Markdown prose styles ─────────────────────────────────────────────── */
/* All colors are inherited from the parent bubble context.                  */
/* Only structural/spacing styles are set here.                              */

.md-content p {
  margin: 0 0 0.5em;
}
.md-content p:last-child {
  margin-bottom: 0;
}

.md-content h1,
.md-content h2,
.md-content h3,
.md-content h4,
.md-content h5,
.md-content h6 {
  font-weight: 600;
  line-height: 1.3;
  margin: 0.75em 0 0.25em;
}
.md-content h1 { font-size: 1.25em; }
.md-content h2 { font-size: 1.1em; }
.md-content h3,
.md-content h4,
.md-content h5,
.md-content h6 { font-size: 1em; }

.md-content ul,
.md-content ol {
  margin: 0.25em 0 0.5em;
  padding-left: 1.5em;
}
.md-content ul { list-style-type: disc; }
.md-content ol { list-style-type: decimal; }
.md-content li { margin: 0.15em 0; }

/* Inline code — semi-transparent darker overlay readable on both
   navy-800 (agent) and cyan-700 (own) bubble backgrounds */
.md-content code:not(pre code) {
  background: rgba(0, 0, 0, 0.25);
  border-radius: 3px;
  padding: 0.15em 0.35em;
  font-size: 0.875em;
  font-family: ui-monospace, 'Cascadia Code', 'Fira Code', monospace;
}

/* Code block wrapper (injected by markdown.ts fence override) */
.md-content .code-block {
  position: relative;
  margin: 0.5em 0;
}
.md-content .code-block:last-child {
  margin-bottom: 0;
}

/* Shiki renders <pre class="shiki ..."><code>...</code></pre> with inline token styles */
.md-content pre.shiki {
  border-radius: 6px;
  padding: 0.75em 1em;
  overflow-x: auto;
  font-size: 0.8em;
  line-height: 1.6;
  font-family: ui-monospace, 'Cascadia Code', 'Fira Code', monospace;
  margin: 0;
}

/* Copy button */
.md-content .copy-btn {
  position: absolute;
  top: 6px;
  right: 6px;
  font-size: 10px;
  padding: 2px 8px;
  border-radius: 4px;
  border: 1px solid rgba(255, 255, 255, 0.15);
  background: rgba(0, 0, 0, 0.4);
  color: rgba(255, 255, 255, 0.6);
  cursor: pointer;
  font-family: ui-monospace, monospace;
  line-height: 1.6;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.md-content .copy-btn:hover {
  background: rgba(0, 0, 0, 0.6);
  color: rgba(255, 255, 255, 0.9);
  border-color: rgba(255, 255, 255, 0.3);
}

/* Blockquote */
.md-content blockquote {
  border-left: 3px solid rgba(255, 255, 255, 0.2);
  padding-left: 0.75em;
  margin: 0.5em 0;
  opacity: 0.8;
}

/* Links */
.md-content a {
  color: inherit;
  text-decoration: underline;
  text-underline-offset: 2px;
}

/* Tables */
.md-content table {
  border-collapse: collapse;
  margin: 0.5em 0;
  font-size: 0.875em;
  width: 100%;
}
.md-content th,
.md-content td {
  padding: 0.3em 0.6em;
  border: 1px solid rgba(255, 255, 255, 0.15);
  text-align: left;
}
.md-content th {
  font-weight: 600;
  background: rgba(0, 0, 0, 0.2);
}

/* Horizontal rule */
.md-content hr {
  border: none;
  border-top: 1px solid rgba(255, 255, 255, 0.15);
  margin: 0.75em 0;
}

.md-content strong { font-weight: 700; }
.md-content em { font-style: italic; }
```

- [ ] **Step 2: Verify the build**

```bash
npm run build
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/assets/style.css
git commit -m "feat(web): add .md-content prose styles and copy button styling"
```

---

## Task 6: Wire up `MessageBubble.vue`

**Files:**
- Modify: `packages/web/src/components/conversations/MessageBubble.vue`

- [ ] **Step 1: Replace plain-text interpolation with `<MarkdownContent>`**

Replace the entire file contents with:

```vue
<!-- packages/web/src/components/conversations/MessageBubble.vue -->
<script setup lang="ts">
import type { MessageData } from '@legion/types';
import MarkdownContent from '../MarkdownContent.vue';

defineProps<{
  message: MessageData;
  isOwn: boolean;
  senderName: string;
}>();
</script>

<template>
  <div
    data-bubble
    class="flex flex-col gap-1"
    :class="isOwn ? 'items-end' : 'items-start'"
  >
    <MarkdownContent
      v-if="message.content?.trim()"
      :content="message.content.trim()"
      class="max-w-[72%] px-3 py-2 text-sm leading-relaxed break-words"
      :class="
        isOwn
          ? 'bg-cyan-700 text-white rounded-[12px_12px_3px_12px]'
          : 'bg-navy-800 text-slate-200 rounded-[12px_12px_12px_3px]'
      "
    />

    <!-- Tool calls / approval cards slot — rendered beneath the bubble -->
    <div v-if="$slots.tools" class="max-w-[72%] flex flex-col gap-1.5">
      <slot name="tools" />
    </div>

    <span class="text-xs text-navy-600">
      {{ senderName }}
    </span>
  </div>
</template>
```

Note: `whitespace-pre-wrap` has been removed — markdown-it handles its own whitespace via `breaks: true`.

- [ ] **Step 2: Verify build**

```bash
npm run build
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/components/conversations/MessageBubble.vue
git commit -m "feat(web): render message bubble content as markdown"
```

---

## Task 7: Wire up `SubThreadBlock.vue`

**Files:**
- Modify: `packages/web/src/components/conversations/SubThreadBlock.vue`

- [ ] **Step 1: Replace plain-text `<p>` with `<MarkdownContent>`**

Replace the entire file contents with:

```vue
<!-- packages/web/src/components/conversations/SubThreadBlock.vue -->
<script setup lang="ts">
import type { MessageEntry } from './ToolCallBlock.vue';
import ToolCallBlock from './ToolCallBlock.vue';
import MarkdownContent from '../MarkdownContent.vue';

defineProps<{ messages: MessageEntry[] }>();
</script>

<template>
  <div class="py-2 px-3 space-y-3">
    <div v-for="msg in messages" :key="msg.id">
      <div class="flex items-baseline gap-2 mb-1">
        <span :style="{ color: msg.authorColour }" class="text-xs font-bold">{{ msg.author }}</span>
        <span class="text-[10px] text-navy-500">{{ msg.timestamp }}</span>
      </div>
      <MarkdownContent
        :content="msg.content"
        class="text-[11px] text-slate-300 leading-relaxed"
      />
      <ToolCallBlock v-for="tc in msg.toolCalls ?? []" :key="tc.id" :entry="tc" />
    </div>
  </div>
</template>
```

- [ ] **Step 2: Verify build**

```bash
npm run build
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/components/conversations/SubThreadBlock.vue
git commit -m "feat(web): render sub-thread message content as markdown"
```

---

## Task 8: Run e2e tests and verify they pass

**Files:** none

- [ ] **Step 1: Run only the markdown tests**

```bash
npx playwright test tests/conversations/markdown.spec.ts --reporter=list
```

Run from `packages/e2e/`. Expected: both tests pass.

If the first test fails (`[data-bubble] strong` not found):
- Check that `MarkdownContent.vue` is imported and used in `MessageBubble.vue`
- Check that `ensureReady()` is completing before render (add a `console.log` in `markdown.ts` to confirm)
- Verify `DOMPurify` is not stripping `<strong>` — it shouldn't be, but add `ADD_TAGS: ['strong']` to the sanitize config if so

If the second test fails (`[data-copy-code]` not found):
- Check that the fence rule override in `markdown.ts` is running (add a `console.log` after the override)
- Check that the Shiki fence rule exists on `md.renderer.rules['fence']` after `md.use(fromHighlighter(...))`
- If the fence rule key is different (e.g. `'code_block'`), adjust accordingly

If the copy button test fails on the clipboard assertion:
- Check that `addInitScript` is injecting the spy before `page.goto()` (it must be called before any navigation)
- Confirm the click event reaches `MarkdownContent.vue`'s `onRootClick` handler
- Check that `btn.closest('.code-block')` finds the wrapper — the wrapper class must match between `markdown.ts` and the CSS

- [ ] **Step 2: Run the full e2e suite to check for regressions**

```bash
npx playwright test --reporter=list
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add .
git commit -m "feat(web): markdown rendering complete — all e2e tests passing"
```
