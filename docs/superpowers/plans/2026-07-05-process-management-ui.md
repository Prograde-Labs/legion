# Process Management UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/processes` section to the Legion SPA — a split-view with process list sidebar and terminal-style detail pane, backed by the existing `ProcessManager` tools and WebSocket subscriptions.

**Architecture:** Mirrors the `ConversationsView` split-view pattern. `ProcessesView` orchestrates `ProcessList` (left sidebar) and either `ProcessStartForm` or `ProcessDetail` (right pane). `useProcess` manages per-process state and WS subscription; `AnsiOutput` owns ANSI rendering and scroll-lock. `useProcesses` handles list fetching and polling.

**Tech Stack:** Vue 3 + Composition API, `ansi_up` (ANSI-to-HTML), `@vue/test-utils`, happy-dom, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-05-process-management-ui-design.md`

---

## File Map

### New files

| File                                                             | Responsibility                                             |
| ---------------------------------------------------------------- | ---------------------------------------------------------- |
| `packages/web/src/components/processes/ProcessStatusDot.vue`     | Colour-coded dot per `ProcessStatus`                       |
| `packages/web/src/components/processes/ProcessStatusDot.test.ts` | Unit tests                                                 |
| `packages/web/src/components/processes/AnsiOutput.vue`           | ANSI-to-HTML renderer, scroll-lock, owns `AnsiUp` instance |
| `packages/web/src/components/processes/AnsiOutput.test.ts`       | Unit tests                                                 |
| `packages/web/src/composables/useProcesses.ts`                   | List fetching + 5s polling singleton                       |
| `packages/web/src/composables/useProcesses.test.ts`              | Unit tests                                                 |
| `packages/web/src/composables/useProcess.ts`                     | Single process: handle, chunks, WS subscription, actions   |
| `packages/web/src/composables/useProcess.test.ts`                | Unit tests                                                 |
| `packages/web/src/components/processes/ProcessStartForm.vue`     | Inline start form (command, args, name, cwd, tty, shell)   |
| `packages/web/src/components/processes/ProcessStartForm.test.ts` | Unit tests                                                 |
| `packages/web/src/components/processes/ProcessList.vue`          | Left sidebar process list                                  |
| `packages/web/src/components/processes/ProcessDetail.vue`        | Terminal-first detail pane                                 |
| `packages/web/src/views/ProcessesView.vue`                       | Root view orchestrator                                     |

### Modified files

| File                                                | Change                                     |
| --------------------------------------------------- | ------------------------------------------ |
| `packages/web/package.json`                         | Add `ansi_up` dependency                   |
| `packages/web/src/router/index.ts`                  | Add `/processes` + `/processes/:id` routes |
| `packages/web/src/components/layout/AppSidebar.vue` | Add Processes nav entry                    |

---

## Task 1: Add `ansi_up` dependency

**Files:**

- Modify: `packages/web/package.json`

- [ ] **Step 1: Add `ansi_up` to dependencies**

In `packages/web/package.json`, add to `"dependencies"`:

```json
"ansi_up": "^6.0.6"
```

Full updated dependencies block:

```json
"dependencies": {
  "@legion/types": "*",
  "@shikijs/markdown-it": "^4.3.1",
  "@vueuse/core": "^11.0.0",
  "ansi_up": "^6.0.6",
  "dompurify": "^3.4.11",
  "markdown-it": "^14.3.0",
  "shiki": "^4.3.1",
  "vue": "^3.4.0",
  "vue-router": "^4.3.0"
}
```

- [ ] **Step 2: Install**

```bash
npm install
```

Expected: `ansi_up` installed in `packages/web/node_modules`. No errors.

- [ ] **Step 3: Verify import**

```bash
node --input-type=module <<'EOF'
import { AnsiUp } from '/home/chris/source/javascript/legion-v2/packages/web/node_modules/ansi_up/ansi_up.js';
const au = new AnsiUp();
console.log(au.ansi_to_html('\x1b[32mhello\x1b[0m'));
EOF
```

Expected: prints `<span style="...">hello</span>` — some span with green colour.

- [ ] **Step 4: Commit**

```bash
git add packages/web/package.json package-lock.json
git commit -m "feat(web): add ansi_up dependency"
```

---

## Task 2: `ProcessStatusDot.vue`

**Files:**

- Create: `packages/web/src/components/processes/ProcessStatusDot.vue`
- Create: `packages/web/src/components/processes/ProcessStatusDot.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/web/src/components/processes/ProcessStatusDot.test.ts`:

```typescript
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import ProcessStatusDot from './ProcessStatusDot.vue';
import type { ProcessStatus } from '@legion/types';

const statuses: ProcessStatus[] = ['running', 'starting', 'exited', 'killed', 'abandoned'];

describe('ProcessStatusDot', () => {
  it('renders a span element', () => {
    const w = mount(ProcessStatusDot, { props: { status: 'running' } });
    expect(w.element.tagName).toBe('SPAN');
  });

  it('running: cyan + animate-pulse', () => {
    const w = mount(ProcessStatusDot, { props: { status: 'running' } });
    expect(w.classes()).toContain('bg-cyan-400');
    expect(w.classes()).toContain('animate-pulse');
  });

  it('starting: amber', () => {
    const w = mount(ProcessStatusDot, { props: { status: 'starting' } });
    expect(w.classes()).toContain('bg-amber-400');
  });

  it('exited: slate', () => {
    const w = mount(ProcessStatusDot, { props: { status: 'exited' } });
    expect(w.classes()).toContain('bg-slate-500');
  });

  it('killed: red', () => {
    const w = mount(ProcessStatusDot, { props: { status: 'killed' } });
    expect(w.classes()).toContain('bg-red-400');
  });

  it('abandoned: navy', () => {
    const w = mount(ProcessStatusDot, { props: { status: 'abandoned' } });
    expect(w.classes()).toContain('bg-navy-500');
  });

  it('all statuses render without throwing', () => {
    for (const status of statuses) {
      expect(() => mount(ProcessStatusDot, { props: { status } })).not.toThrow();
    }
  });
});
```

- [ ] **Step 2: Run — verify FAIL**

```bash
npm run test --workspace=packages/web -- --reporter=verbose packages/web/src/components/processes/ProcessStatusDot.test.ts
```

Expected: FAIL — `Cannot find module './ProcessStatusDot.vue'`.

- [ ] **Step 3: Implement `ProcessStatusDot.vue`**

Create `packages/web/src/components/processes/ProcessStatusDot.vue`:

```vue
<script setup lang="ts">
import type { ProcessStatus } from '@legion/types';

defineProps<{ status: ProcessStatus }>();

const colours: Record<ProcessStatus, string> = {
  running: 'bg-cyan-400 animate-pulse',
  starting: 'bg-amber-400',
  exited: 'bg-slate-500',
  killed: 'bg-red-400',
  abandoned: 'bg-navy-500',
};
</script>
<template>
  <span :class="['inline-block w-2 h-2 rounded-full', colours[status] ?? 'bg-navy-500']" />
</template>
```

- [ ] **Step 4: Run — verify PASS**

```bash
npm run test --workspace=packages/web -- --reporter=verbose packages/web/src/components/processes/ProcessStatusDot.test.ts
```

Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/processes/ProcessStatusDot.vue packages/web/src/components/processes/ProcessStatusDot.test.ts
git commit -m "feat(web): add ProcessStatusDot component"
```

---

## Task 3: `AnsiOutput.vue`

**Files:**

- Create: `packages/web/src/components/processes/AnsiOutput.vue`
- Create: `packages/web/src/components/processes/AnsiOutput.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/web/src/components/processes/AnsiOutput.test.ts`:

```typescript
import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

// Mock ansi_up — pass-through with light ANSI stripping for test clarity
vi.mock('ansi_up', () => ({
  AnsiUp: class {
    ansi_to_html(text: string): string {
      // Strip ANSI escape codes, return plain text (sufficient for tests)
      return text.replace(/\x1b\[[0-9;]*m/g, '');
    }
  },
}));

describe('AnsiOutput', () => {
  it('renders a pre element', async () => {
    const { default: AnsiOutput } = await import('./AnsiOutput.vue');
    const w = mount(AnsiOutput, { props: { chunks: [] } });
    expect(w.find('pre').exists()).toBe(true);
  });

  it('renders initial chunks on mount', async () => {
    const { default: AnsiOutput } = await import('./AnsiOutput.vue');
    const w = mount(AnsiOutput, { props: { chunks: ['hello world'] } });
    await nextTick();
    expect(w.find('pre').html()).toContain('hello world');
  });

  it('appends newly added chunks without re-processing old ones', async () => {
    const { default: AnsiOutput } = await import('./AnsiOutput.vue');
    const w = mount(AnsiOutput, { props: { chunks: ['first '] } });
    await nextTick();
    await w.setProps({ chunks: ['first ', 'second'] });
    await nextTick();
    const html = w.find('pre').html();
    expect(html).toContain('first');
    expect(html).toContain('second');
  });

  it('does not re-process existing chunks when new ones are added', async () => {
    let callCount = 0;
    vi.doMock('ansi_up', () => ({
      AnsiUp: class {
        ansi_to_html(text: string): string {
          callCount++;
          return text;
        }
      },
    }));

    // Use fresh module to pick up updated mock
    vi.resetModules();
    const { default: AnsiOutput } = await import('./AnsiOutput.vue');
    const w = mount(AnsiOutput, { props: { chunks: ['a'] } });
    await nextTick();
    const callsAfterFirst = callCount;

    await w.setProps({ chunks: ['a', 'b'] });
    await nextTick();

    // Only one new call for 'b', not a re-process of 'a'
    expect(callCount - callsAfterFirst).toBe(1);

    vi.doUnmock('ansi_up');
    vi.resetModules();
  });

  it('renders empty pre when no chunks provided', async () => {
    const { default: AnsiOutput } = await import('./AnsiOutput.vue');
    const w = mount(AnsiOutput, { props: { chunks: [] } });
    await nextTick();
    // pre exists and has no meaningful content
    expect(w.find('pre').exists()).toBe(true);
  });
});
```

- [ ] **Step 2: Run — verify FAIL**

```bash
npm run test --workspace=packages/web -- --reporter=verbose packages/web/src/components/processes/AnsiOutput.test.ts
```

Expected: FAIL — `Cannot find module './AnsiOutput.vue'`.

- [ ] **Step 3: Implement `AnsiOutput.vue`**

Create `packages/web/src/components/processes/AnsiOutput.vue`:

```vue
<script setup lang="ts">
import { ref, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { AnsiUp } from 'ansi_up';

const props = defineProps<{ chunks: string[] }>();

const ansiUp = new AnsiUp();
const renderedHtml = ref('');
const preEl = ref<HTMLPreElement | null>(null);
const atBottom = ref(true);
let processed = 0;

function processNewChunks(): void {
  const newChunks = props.chunks.slice(processed);
  if (newChunks.length === 0) return;
  for (const chunk of newChunks) {
    renderedHtml.value += ansiUp.ansi_to_html(chunk);
  }
  processed = props.chunks.length;
  void nextTick(() => {
    if (atBottom.value && preEl.value) {
      preEl.value.scrollTop = preEl.value.scrollHeight;
    }
  });
}

function onScroll(): void {
  if (!preEl.value) return;
  atBottom.value = preEl.value.scrollHeight - preEl.value.scrollTop - preEl.value.clientHeight < 50;
}

function scrollToBottom(): void {
  if (!preEl.value) return;
  preEl.value.scrollTop = preEl.value.scrollHeight;
  atBottom.value = true;
}

watch(() => props.chunks.length, processNewChunks);

onMounted(() => {
  preEl.value?.addEventListener('scroll', onScroll);
  processNewChunks();
});

onUnmounted(() => {
  preEl.value?.removeEventListener('scroll', onScroll);
});
</script>

<template>
  <div class="relative flex-1 min-h-0 overflow-hidden">
    <pre
      ref="preEl"
      class="h-full overflow-y-auto m-0 rounded"
      style="background: #0a111e; font-family: 'JetBrains Mono', 'Fira Mono', 'Cascadia Code', monospace; font-size: 11.5px; line-height: 1.65; padding: 14px 16px; color: #cbd5e1"
      v-html="renderedHtml"
    />
    <button
      v-if="!atBottom"
      class="absolute bottom-3 right-3 text-[10px] px-2 py-1 rounded bg-navy-700 text-slate-300 hover:bg-navy-600 border border-navy-600"
      @click="scrollToBottom"
    >
      ↓ scroll to bottom
    </button>
  </div>
</template>
```

- [ ] **Step 4: Run — verify PASS**

```bash
npm run test --workspace=packages/web -- --reporter=verbose packages/web/src/components/processes/AnsiOutput.test.ts
```

Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/processes/AnsiOutput.vue packages/web/src/components/processes/AnsiOutput.test.ts
git commit -m "feat(web): add AnsiOutput component"
```

---

## Task 4: `useProcesses.ts`

**Files:**

- Create: `packages/web/src/composables/useProcesses.ts`
- Create: `packages/web/src/composables/useProcesses.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/web/src/composables/useProcesses.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { defineComponent } from 'vue';
import { mount } from '@vue/test-utils';

vi.mock('./useExecute.js', () => ({
  useExecute: vi.fn(() => ({
    execute: vi.fn().mockResolvedValue([]),
  })),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

describe('useProcesses', () => {
  it('exports processes, loading, error, refresh', async () => {
    const { useProcesses } = await import('./useProcesses.js');
    const TestComponent = defineComponent({
      setup() {
        const result = useProcesses();
        return result;
      },
      template: '<div/>',
    });
    const w = mount(TestComponent);
    const { processes, loading, error, refresh } = w.vm as any;
    expect(typeof refresh).toBe('function');
    expect(Array.isArray(processes)).toBe(true);
    expect(typeof loading).toBe('boolean');
    w.unmount();
  });

  it('calls list_processes on first use', async () => {
    const { useExecute } = (await import('./useExecute.js')) as any;
    const executeMock = vi.fn().mockResolvedValue([]);
    useExecute.mockReturnValue({ execute: executeMock });

    const { useProcesses } = await import('./useProcesses.js');
    const TestComponent = defineComponent({
      setup() {
        return useProcesses();
      },
      template: '<div/>',
    });
    const w = mount(TestComponent);
    // Wait for async refresh
    await new Promise((r) => setTimeout(r, 0));
    expect(executeMock).toHaveBeenCalledWith('list_processes', { status: 'all' });
    w.unmount();
  });

  it('populates processes from execute result', async () => {
    const { useExecute } = (await import('./useExecute.js')) as any;
    const fakeProcesses = [
      {
        id: 'proc-1',
        command: 'sleep',
        args: ['10'],
        cwd: '/tmp',
        tty: false,
        shell: false,
        startedAt: '2026-01-01T00:00:00Z',
        startedByParticipantId: 'op',
        pid: 1234,
        status: 'running',
        exitCode: null,
        exitedAt: null,
      },
    ];
    useExecute.mockReturnValue({ execute: vi.fn().mockResolvedValue(fakeProcesses) });

    const { useProcesses } = await import('./useProcesses.js');
    const TestComponent = defineComponent({
      setup() {
        return useProcesses();
      },
      template: '<div/>',
    });
    const w = mount(TestComponent);
    await new Promise((r) => setTimeout(r, 0));
    expect((w.vm as any).processes).toHaveLength(1);
    expect((w.vm as any).processes[0].id).toBe('proc-1');
    w.unmount();
  });

  it('clears poll interval when last consumer unmounts', async () => {
    vi.useFakeTimers();
    const { useExecute } = (await import('./useExecute.js')) as any;
    const executeMock = vi.fn().mockResolvedValue([]);
    useExecute.mockReturnValue({ execute: executeMock });

    const { useProcesses } = await import('./useProcesses.js');
    const TestComponent = defineComponent({
      setup() {
        return useProcesses();
      },
      template: '<div/>',
    });
    const w = mount(TestComponent);
    await vi.runAllTicks();
    const callsAtMount = executeMock.mock.calls.length;

    w.unmount();
    // After unmount, advancing 10s should NOT trigger additional calls
    await vi.advanceTimersByTimeAsync(10_000);
    expect(executeMock.mock.calls.length).toBe(callsAtMount);

    vi.useRealTimers();
  });

  it('refresh() re-fetches and updates processes', async () => {
    const { useExecute } = (await import('./useExecute.js')) as any;
    const executeMock = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 'proc-2',
          command: 'echo',
          args: [],
          cwd: '/tmp',
          tty: false,
          shell: false,
          startedAt: '2026-01-01T00:00:00Z',
          startedByParticipantId: 'op',
          pid: 999,
          status: 'exited',
          exitCode: 0,
          exitedAt: '2026-01-01T00:00:01Z',
        },
      ]);
    useExecute.mockReturnValue({ execute: executeMock });

    const { useProcesses } = await import('./useProcesses.js');
    const TestComponent = defineComponent({
      setup() {
        return useProcesses();
      },
      template: '<div/>',
    });
    const w = mount(TestComponent);
    await new Promise((r) => setTimeout(r, 0));
    expect((w.vm as any).processes).toHaveLength(0);

    await (w.vm as any).refresh();
    expect((w.vm as any).processes).toHaveLength(1);
    expect((w.vm as any).processes[0].id).toBe('proc-2');
    w.unmount();
  });
});
```

- [ ] **Step 2: Run — verify FAIL**

```bash
npm run test --workspace=packages/web -- --reporter=verbose packages/web/src/composables/useProcesses.test.ts
```

Expected: FAIL — `Cannot find module './useProcesses.js'`.

- [ ] **Step 3: Implement `useProcesses.ts`**

Create `packages/web/src/composables/useProcesses.ts`:

```typescript
import { ref, onUnmounted, getCurrentInstance } from 'vue';
import type { Ref } from 'vue';
import { useExecute } from './useExecute.js';
import type { ProcessHandle } from '@legion/types';

// Module-level singleton — one shared list for the whole app
const processes: Ref<ProcessHandle[]> = ref([]);
const loading: Ref<boolean> = ref(false);
const error: Ref<string | null> = ref(null);
let consumerCount = 0;
let pollInterval: ReturnType<typeof setInterval> | null = null;

async function refresh(): Promise<void> {
  const { execute } = useExecute();
  loading.value = true;
  try {
    processes.value = await execute<ProcessHandle[]>('list_processes', { status: 'all' });
    error.value = null;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

export function useProcesses() {
  consumerCount++;
  void refresh();

  if (!pollInterval) {
    pollInterval = setInterval(() => void refresh(), 5000);
  }

  if (getCurrentInstance()) {
    onUnmounted(() => {
      consumerCount--;
      if (consumerCount === 0 && pollInterval !== null) {
        clearInterval(pollInterval);
        pollInterval = null;
      }
    });
  }

  return { processes, loading, error, refresh };
}
```

- [ ] **Step 4: Run — verify PASS**

```bash
npm run test --workspace=packages/web -- --reporter=verbose packages/web/src/composables/useProcesses.test.ts
```

Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/composables/useProcesses.ts packages/web/src/composables/useProcesses.test.ts
git commit -m "feat(web): add useProcesses composable"
```

---

## Task 5: `useProcess.ts`

**Files:**

- Create: `packages/web/src/composables/useProcess.ts`
- Create: `packages/web/src/composables/useProcess.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/web/src/composables/useProcess.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { defineComponent } from 'vue';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';

// Module-level WS handler tracking for the mock
const wsHandlers = new Set<(data: unknown) => void>();
const wsSendMock = vi.fn();

vi.mock('./useWebSocket.js', () => ({
  useWebSocket: () => ({
    send: wsSendMock,
    onMessage: (h: (data: unknown) => void) => {
      wsHandlers.add(h);
      return () => wsHandlers.delete(h);
    },
    connect: vi.fn(),
    disconnect: vi.fn(),
  }),
}));

const executeMock = vi.fn();
vi.mock('./useExecute.js', () => ({
  useExecute: () => ({ execute: executeMock }),
}));

const RUNNING_HANDLE = {
  id: 'proc-1',
  command: 'sleep',
  args: ['30'],
  cwd: '/tmp',
  tty: false,
  shell: false,
  startedAt: '2026-01-01T00:00:00.000Z',
  startedByParticipantId: 'op',
  pid: 9999,
  status: 'running',
  exitCode: null,
  exitedAt: null,
};

const EXITED_HANDLE = {
  ...RUNNING_HANDLE,
  status: 'exited',
  exitCode: 0,
  exitedAt: '2026-01-01T00:00:30.000Z',
};

function emit(data: unknown): void {
  for (const h of wsHandlers) h(data);
}

function makeComponent(id: string) {
  return defineComponent({
    setup() {
      // Lazy import to pick up mocks
      return { _id: id };
    },
    template: '<div/>',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  wsHandlers.clear();
  vi.resetModules();
});

describe('useProcess', () => {
  it('fetches handle on load', async () => {
    const { useProcess } = await import('./useProcess.js');
    executeMock.mockResolvedValueOnce(RUNNING_HANDLE); // get_process
    executeMock.mockResolvedValueOnce({ data: btoa('hello'), totalBytes: 5, from: 0 }); // read_process_output

    const TestComponent = defineComponent({
      setup() {
        return useProcess('proc-1');
      },
      template: '<div/>',
    });
    const w = mount(TestComponent);
    await nextTick();
    await new Promise((r) => setTimeout(r, 0));
    expect((w.vm as any).handle?.id).toBe('proc-1');
    w.unmount();
  });

  it('loads output tail for running process', async () => {
    const { useProcess } = await import('./useProcess.js');
    executeMock.mockResolvedValueOnce(RUNNING_HANDLE);
    executeMock.mockResolvedValueOnce({ data: btoa('hello world'), totalBytes: 11, from: 0 });

    const TestComponent = defineComponent({
      setup() {
        return useProcess('proc-1');
      },
      template: '<div/>',
    });
    const w = mount(TestComponent);
    await new Promise((r) => setTimeout(r, 0));
    expect((w.vm as any).chunks).toContain('hello world');
    w.unmount();
  });

  it('sends subscribe_process for running process', async () => {
    const { useProcess } = await import('./useProcess.js');
    executeMock.mockResolvedValueOnce(RUNNING_HANDLE);
    executeMock.mockResolvedValueOnce({ data: btoa(''), totalBytes: 0, from: 0 });

    const TestComponent = defineComponent({
      setup() {
        return useProcess('proc-1');
      },
      template: '<div/>',
    });
    const w = mount(TestComponent);
    await new Promise((r) => setTimeout(r, 0));
    expect(wsSendMock).toHaveBeenCalledWith({ type: 'subscribe_process', processId: 'proc-1' });
    w.unmount();
  });

  it('does not subscribe for exited process', async () => {
    const { useProcess } = await import('./useProcess.js');
    executeMock.mockResolvedValueOnce(EXITED_HANDLE);
    executeMock.mockResolvedValueOnce({ data: btoa('old output'), totalBytes: 10, from: 0 });

    const TestComponent = defineComponent({
      setup() {
        return useProcess('proc-1');
      },
      template: '<div/>',
    });
    const w = mount(TestComponent);
    await new Promise((r) => setTimeout(r, 0));
    expect(wsSendMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'subscribe_process' }),
    );
    w.unmount();
  });

  it('appends chunk on process:output message', async () => {
    const { useProcess } = await import('./useProcess.js');
    executeMock.mockResolvedValueOnce(RUNNING_HANDLE);
    executeMock.mockResolvedValueOnce({ data: btoa(''), totalBytes: 0, from: 0 });

    const TestComponent = defineComponent({
      setup() {
        return useProcess('proc-1');
      },
      template: '<div/>',
    });
    const w = mount(TestComponent);
    await new Promise((r) => setTimeout(r, 0));

    emit({
      type: 'process:output',
      processId: 'proc-1',
      stream: 'stdout',
      data: btoa('new line\n'),
    });
    await nextTick();

    expect((w.vm as any).chunks).toContain('new line\n');
    w.unmount();
  });

  it('ignores process:output for a different processId', async () => {
    const { useProcess } = await import('./useProcess.js');
    executeMock.mockResolvedValueOnce(RUNNING_HANDLE);
    executeMock.mockResolvedValueOnce({ data: btoa(''), totalBytes: 0, from: 0 });

    const TestComponent = defineComponent({
      setup() {
        return useProcess('proc-1');
      },
      template: '<div/>',
    });
    const w = mount(TestComponent);
    await new Promise((r) => setTimeout(r, 0));
    const before = (w.vm as any).chunks.length;

    emit({ type: 'process:output', processId: 'proc-OTHER', stream: 'stdout', data: btoa('nope') });
    await nextTick();

    expect((w.vm as any).chunks.length).toBe(before);
    w.unmount();
  });

  it('updates handle status on process:exited', async () => {
    const { useProcess } = await import('./useProcess.js');
    executeMock.mockResolvedValueOnce(RUNNING_HANDLE);
    executeMock.mockResolvedValueOnce({ data: btoa(''), totalBytes: 0, from: 0 });

    const TestComponent = defineComponent({
      setup() {
        return useProcess('proc-1');
      },
      template: '<div/>',
    });
    const w = mount(TestComponent);
    await new Promise((r) => setTimeout(r, 0));

    emit({ type: 'process:exited', processId: 'proc-1', exitCode: 0, signal: null });
    await nextTick();

    expect((w.vm as any).handle?.status).toBe('exited');
    expect((w.vm as any).handle?.exitCode).toBe(0);
    w.unmount();
  });

  it('sends unsubscribe_process on unmount', async () => {
    const { useProcess } = await import('./useProcess.js');
    executeMock.mockResolvedValueOnce(RUNNING_HANDLE);
    executeMock.mockResolvedValueOnce({ data: btoa(''), totalBytes: 0, from: 0 });

    const TestComponent = defineComponent({
      setup() {
        return useProcess('proc-1');
      },
      template: '<div/>',
    });
    const w = mount(TestComponent);
    await new Promise((r) => setTimeout(r, 0));
    wsSendMock.mockClear();

    w.unmount();
    expect(wsSendMock).toHaveBeenCalledWith({ type: 'unsubscribe_process', processId: 'proc-1' });
  });

  it('stop() calls stop_process and updates handle', async () => {
    const { useProcess } = await import('./useProcess.js');
    const stoppedHandle = {
      ...RUNNING_HANDLE,
      status: 'killed',
      exitCode: null,
      exitedAt: '2026-01-01T00:01:00.000Z',
    };
    executeMock.mockResolvedValueOnce(RUNNING_HANDLE); // get_process
    executeMock.mockResolvedValueOnce({ data: btoa(''), totalBytes: 0, from: 0 }); // read_output
    executeMock.mockResolvedValueOnce(stoppedHandle); // stop_process

    const TestComponent = defineComponent({
      setup() {
        return useProcess('proc-1');
      },
      template: '<div/>',
    });
    const w = mount(TestComponent);
    await new Promise((r) => setTimeout(r, 0));

    await (w.vm as any).stop();
    expect(executeMock).toHaveBeenCalledWith('stop_process', { id: 'proc-1' });
    expect((w.vm as any).handle?.status).toBe('killed');
    w.unmount();
  });

  it('send() calls write_process_input', async () => {
    const { useProcess } = await import('./useProcess.js');
    executeMock.mockResolvedValueOnce(RUNNING_HANDLE);
    executeMock.mockResolvedValueOnce({ data: btoa(''), totalBytes: 0, from: 0 });
    executeMock.mockResolvedValueOnce({ ok: true });

    const TestComponent = defineComponent({
      setup() {
        return useProcess('proc-1');
      },
      template: '<div/>',
    });
    const w = mount(TestComponent);
    await new Promise((r) => setTimeout(r, 0));

    await (w.vm as any).send('hello\n');
    expect(executeMock).toHaveBeenCalledWith('write_process_input', {
      id: 'proc-1',
      data: 'hello\n',
    });
    w.unmount();
  });

  it('del() calls delete_process', async () => {
    const { useProcess } = await import('./useProcess.js');
    executeMock.mockResolvedValueOnce(EXITED_HANDLE);
    executeMock.mockResolvedValueOnce({ data: btoa(''), totalBytes: 0, from: 0 });
    executeMock.mockResolvedValueOnce({ ok: true, id: 'proc-1' });

    const TestComponent = defineComponent({
      setup() {
        return useProcess('proc-1');
      },
      template: '<div/>',
    });
    const w = mount(TestComponent);
    await new Promise((r) => setTimeout(r, 0));

    await (w.vm as any).del();
    expect(executeMock).toHaveBeenCalledWith('delete_process', { id: 'proc-1' });
    w.unmount();
  });
});
```

- [ ] **Step 2: Run — verify FAIL**

```bash
npm run test --workspace=packages/web -- --reporter=verbose packages/web/src/composables/useProcess.test.ts
```

Expected: FAIL — `Cannot find module './useProcess.js'`.

- [ ] **Step 3: Implement `useProcess.ts`**

Create `packages/web/src/composables/useProcess.ts`:

```typescript
import { ref, onMounted, onUnmounted } from 'vue';
import type { Ref } from 'vue';
import { useExecute } from './useExecute.js';
import { useWebSocket } from './useWebSocket.js';
import type { ProcessHandle } from '@legion/types';

export function useProcess(processId: string) {
  const { execute } = useExecute();
  const { send: wsSend, onMessage } = useWebSocket();

  const handle: Ref<ProcessHandle | null> = ref(null);
  const chunks: Ref<string[]> = ref([]);
  const error: Ref<string | null> = ref(null);

  let subscribed = false;
  let offMessage: (() => void) | null = null;

  function handleWsMessage(raw: unknown): void {
    const msg = raw as {
      type: string;
      processId: string;
      data?: string;
      exitCode?: number | null;
      signal?: string | null;
      error?: string;
    };
    if (msg.processId !== processId) return;

    if (msg.type === 'process:output' && msg.data) {
      chunks.value.push(atob(msg.data));
    } else if (msg.type === 'process:exited') {
      if (handle.value) {
        handle.value = {
          ...handle.value,
          status: msg.signal != null ? 'killed' : 'exited',
          exitCode: msg.exitCode ?? null,
          exitedAt: new Date().toISOString(),
        };
      }
      // Server auto-detaches subscription; just clean up our listener
      if (offMessage) {
        offMessage();
        offMessage = null;
      }
      subscribed = false;
    } else if (msg.type === 'process:error') {
      error.value = msg.error ?? 'Unknown process error';
    }
  }

  function cleanup(): void {
    if (offMessage) {
      offMessage();
      offMessage = null;
    }
    if (subscribed) {
      wsSend({ type: 'unsubscribe_process', processId });
      subscribed = false;
    }
  }

  onMounted(async () => {
    try {
      handle.value = await execute<ProcessHandle>('get_process', { id: processId });
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
      return;
    }

    if (handle.value.status === 'running') {
      try {
        const tail = await execute<{ data: string; totalBytes: number; from: number }>(
          'read_process_output',
          { id: processId, bytes: 65536, decode: 'base64' },
        );
        if (tail.data) chunks.value.push(atob(tail.data));
      } catch {
        // non-fatal — live stream will provide output
      }

      offMessage = onMessage(handleWsMessage);
      wsSend({ type: 'subscribe_process', processId });
      subscribed = true;
    } else {
      // Historical: fetch tail from log file (may be large)
      try {
        const tail = await execute<{ data: string; totalBytes: number; from: number }>(
          'read_process_output',
          { id: processId, bytes: 65536, decode: 'base64' },
        );
        if (tail.data) chunks.value.push(atob(tail.data));
      } catch {
        // non-fatal
      }
    }
  });

  onUnmounted(() => {
    cleanup();
  });

  async function stop(): Promise<void> {
    const result = await execute<ProcessHandle>('stop_process', { id: processId });
    handle.value = result;
  }

  async function send(data: string): Promise<void> {
    await execute('write_process_input', { id: processId, data });
  }

  async function del(): Promise<void> {
    await execute('delete_process', { id: processId });
  }

  return { handle, chunks, error, stop, send, del };
}
```

- [ ] **Step 4: Run — verify PASS**

```bash
npm run test --workspace=packages/web -- --reporter=verbose packages/web/src/composables/useProcess.test.ts
```

Expected: 11 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/composables/useProcess.ts packages/web/src/composables/useProcess.test.ts
git commit -m "feat(web): add useProcess composable"
```

---

## Task 6: `ProcessStartForm.vue`

**Files:**

- Create: `packages/web/src/components/processes/ProcessStartForm.vue`
- Create: `packages/web/src/components/processes/ProcessStartForm.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/web/src/components/processes/ProcessStartForm.test.ts`:

```typescript
import { mount } from '@vue/test-utils';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { nextTick } from 'vue';

const executeMock = vi.fn();
vi.mock('../../composables/useExecute.js', () => ({
  useExecute: () => ({ execute: executeMock }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

describe('ProcessStartForm', () => {
  it('renders a command input', async () => {
    const { default: ProcessStartForm } = await import('./ProcessStartForm.vue');
    const w = mount(ProcessStartForm);
    expect(w.find('input[placeholder*="command"]').exists()).toBe(true);
  });

  it('submit button is disabled when command is empty', async () => {
    const { default: ProcessStartForm } = await import('./ProcessStartForm.vue');
    const w = mount(ProcessStartForm);
    const btn = w.find('button[type="submit"]');
    expect(btn.attributes('disabled')).toBeDefined();
  });

  it('submit button is enabled when command is filled', async () => {
    const { default: ProcessStartForm } = await import('./ProcessStartForm.vue');
    const w = mount(ProcessStartForm);
    await w.find('input[placeholder*="command"]').setValue('npm');
    await nextTick();
    const btn = w.find('button[type="submit"]');
    expect(btn.attributes('disabled')).toBeUndefined();
  });

  it('calls start_process with correct args on submit', async () => {
    const { default: ProcessStartForm } = await import('./ProcessStartForm.vue');
    executeMock.mockResolvedValue({
      id: 'proc-new',
      status: 'running',
      command: 'npm',
      args: ['run', 'dev'],
      cwd: '/tmp',
      tty: false,
      shell: false,
      startedAt: '2026-01-01T00:00:00Z',
      startedByParticipantId: 'op',
      pid: 1,
      exitCode: null,
      exitedAt: null,
    });

    const w = mount(ProcessStartForm);
    await w.find('input[placeholder*="command"]').setValue('npm');
    await w.find('input[placeholder*="args"]').setValue('run dev');
    await nextTick();
    await w.find('button[type="submit"]').trigger('click');
    await new Promise((r) => setTimeout(r, 0));

    expect(executeMock).toHaveBeenCalledWith(
      'start_process',
      expect.objectContaining({
        command: 'npm',
        args: ['run', 'dev'],
      }),
    );
  });

  it('emits started event with process id on success', async () => {
    const { default: ProcessStartForm } = await import('./ProcessStartForm.vue');
    executeMock.mockResolvedValue({
      id: 'proc-new',
      status: 'running',
      command: 'echo',
      args: [],
      cwd: '/tmp',
      tty: false,
      shell: false,
      startedAt: '2026-01-01T00:00:00Z',
      startedByParticipantId: 'op',
      pid: 1,
      exitCode: null,
      exitedAt: null,
    });

    const w = mount(ProcessStartForm);
    await w.find('input[placeholder*="command"]').setValue('echo');
    await nextTick();
    await w.find('button[type="submit"]').trigger('click');
    await new Promise((r) => setTimeout(r, 0));

    expect(w.emitted('started')).toBeTruthy();
    expect(w.emitted('started')![0]).toEqual(['proc-new']);
  });

  it('shows inline error and keeps form open on failure', async () => {
    const { default: ProcessStartForm } = await import('./ProcessStartForm.vue');
    executeMock.mockRejectedValue(new Error('spawn ENOENT'));

    const w = mount(ProcessStartForm);
    await w.find('input[placeholder*="command"]').setValue('does-not-exist');
    await nextTick();
    await w.find('button[type="submit"]').trigger('click');
    await new Promise((r) => setTimeout(r, 0));
    await nextTick();

    expect(w.text()).toContain('spawn ENOENT');
    // Form still present
    expect(w.find('input[placeholder*="command"]').exists()).toBe(true);
  });

  it('splits args string on spaces', async () => {
    const { default: ProcessStartForm } = await import('./ProcessStartForm.vue');
    executeMock.mockResolvedValue({
      id: 'proc-x',
      status: 'running',
      command: 'npm',
      args: ['run', 'build'],
      cwd: '/tmp',
      tty: false,
      shell: false,
      startedAt: '2026-01-01T00:00:00Z',
      startedByParticipantId: 'op',
      pid: 2,
      exitCode: null,
      exitedAt: null,
    });

    const w = mount(ProcessStartForm);
    await w.find('input[placeholder*="command"]').setValue('npm');
    await w.find('input[placeholder*="args"]').setValue('run  build'); // extra space
    await nextTick();
    await w.find('button[type="submit"]').trigger('click');
    await new Promise((r) => setTimeout(r, 0));

    expect(executeMock).toHaveBeenCalledWith(
      'start_process',
      expect.objectContaining({
        args: ['run', 'build'], // extra space stripped
      }),
    );
  });
});
```

- [ ] **Step 2: Run — verify FAIL**

```bash
npm run test --workspace=packages/web -- --reporter=verbose packages/web/src/components/processes/ProcessStartForm.test.ts
```

Expected: FAIL — `Cannot find module './ProcessStartForm.vue'`.

- [ ] **Step 3: Implement `ProcessStartForm.vue`**

Create `packages/web/src/components/processes/ProcessStartForm.vue`:

```vue
<script setup lang="ts">
import { ref, computed } from 'vue';
import { useExecute } from '../../composables/useExecute.js';
import type { ProcessHandle } from '@legion/types';

const emit = defineEmits<{ started: [id: string] }>();

const { execute } = useExecute();

const command = ref('');
const argsStr = ref('');
const name = ref('');
const cwd = ref('');
const tty = ref(false);
const shell = ref(false);
const submitting = ref(false);
const error = ref<string | null>(null);

const canSubmit = computed(() => command.value.trim().length > 0 && !submitting.value);

async function onSubmit(): Promise<void> {
  if (!canSubmit.value) return;
  submitting.value = true;
  error.value = null;
  try {
    const args = argsStr.value
      .trim()
      .split(/\s+/)
      .filter((a) => a.length > 0);
    const handle = await execute<ProcessHandle>('start_process', {
      command: command.value.trim(),
      args,
      ...(name.value.trim() ? { name: name.value.trim() } : {}),
      ...(cwd.value.trim() ? { cwd: cwd.value.trim() } : {}),
      tty: tty.value,
      shell: shell.value,
    });
    emit('started', handle.id);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="flex-1 flex flex-col items-center justify-center p-8">
    <div class="w-full max-w-lg">
      <h2 class="text-sm font-semibold text-slate-100 mb-5">Start a process</h2>

      <div class="space-y-3">
        <div>
          <label class="block text-[10px] uppercase tracking-wider text-navy-500 mb-1"
            >Command</label
          >
          <input
            v-model="command"
            placeholder="command e.g. npm"
            class="w-full bg-navy-950 border border-navy-600 rounded px-3 py-2 text-xs text-slate-200 outline-none focus:border-cyan-400/50 font-mono"
            @keydown.enter="onSubmit"
          />
        </div>

        <div>
          <label class="block text-[10px] uppercase tracking-wider text-navy-500 mb-1">Args</label>
          <input
            v-model="argsStr"
            placeholder="args e.g. run dev"
            class="w-full bg-navy-950 border border-navy-600 rounded px-3 py-2 text-xs text-slate-200 outline-none focus:border-cyan-400/50 font-mono"
            @keydown.enter="onSubmit"
          />
        </div>

        <div class="flex gap-3">
          <div class="flex-1">
            <label class="block text-[10px] uppercase tracking-wider text-navy-500 mb-1"
              >Name (optional)</label
            >
            <input
              v-model="name"
              placeholder="display name"
              class="w-full bg-navy-950 border border-navy-600 rounded px-3 py-2 text-xs text-slate-200 outline-none focus:border-cyan-400/50"
            />
          </div>
          <div class="flex-1">
            <label class="block text-[10px] uppercase tracking-wider text-navy-500 mb-1"
              >Working dir (optional)</label
            >
            <input
              v-model="cwd"
              placeholder="/path/to/dir"
              class="w-full bg-navy-950 border border-navy-600 rounded px-3 py-2 text-xs text-slate-200 outline-none focus:border-cyan-400/50 font-mono"
            />
          </div>
        </div>

        <div class="flex gap-5 text-xs text-slate-400">
          <label class="flex items-center gap-2 cursor-pointer select-none">
            <input v-model="tty" type="checkbox" class="accent-cyan-400" />
            <span>TTY (pseudo-terminal)</span>
          </label>
          <label class="flex items-center gap-2 cursor-pointer select-none">
            <input v-model="shell" type="checkbox" class="accent-cyan-400" />
            <span>Shell (<code>/bin/sh -c</code>)</span>
          </label>
        </div>

        <div
          v-if="error"
          class="text-xs text-red-400 bg-red-950/30 border border-red-900/40 rounded px-3 py-2"
        >
          {{ error }}
        </div>

        <button
          type="submit"
          :disabled="!canSubmit"
          class="w-full px-4 py-2 text-xs font-semibold rounded border transition-colors"
          :class="
            canSubmit
              ? 'bg-cyan-400/10 border-cyan-400/40 text-cyan-300 hover:bg-cyan-400/20'
              : 'border-navy-700 text-navy-600 cursor-not-allowed'
          "
          @click="onSubmit"
        >
          {{ submitting ? 'Starting…' : '▶ Start process' }}
        </button>
      </div>
    </div>
  </div>
</template>
```

- [ ] **Step 4: Run — verify PASS**

```bash
npm run test --workspace=packages/web -- --reporter=verbose packages/web/src/components/processes/ProcessStartForm.test.ts
```

Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/processes/ProcessStartForm.vue packages/web/src/components/processes/ProcessStartForm.test.ts
git commit -m "feat(web): add ProcessStartForm component"
```

---

## Task 7: `ProcessList.vue`

**Files:**

- Create: `packages/web/src/components/processes/ProcessList.vue`

No separate test — pure display component; behaviour covered by `ProcessesView` integration.

- [ ] **Step 1: Implement `ProcessList.vue`**

Create `packages/web/src/components/processes/ProcessList.vue`:

```vue
<script setup lang="ts">
import { useRouter } from 'vue-router';
import { computed } from 'vue';
import type { ProcessHandle } from '@legion/types';
import ProcessStatusDot from './ProcessStatusDot.vue';

const props = defineProps<{
  processes: ProcessHandle[];
  activeId: string | null;
}>();

const router = useRouter();

function elapsed(p: ProcessHandle): string {
  const start = new Date(p.startedAt).getTime();
  const end = p.exitedAt ? new Date(p.exitedAt).getTime() : Date.now();
  const s = Math.floor((end - start) / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

const sorted = computed(() =>
  [...props.processes].sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
  ),
);
</script>

<template>
  <div class="flex flex-col h-full">
    <!-- Header -->
    <div
      class="flex items-center justify-between px-3 py-2.5 border-b border-navy-800 flex-shrink-0"
    >
      <span class="text-xs uppercase tracking-wider text-slate-500">Processes</span>
      <button
        class="text-xs px-2 py-0.5 rounded bg-cyan-800 text-cyan-200 hover:bg-cyan-700"
        @click="router.push('/processes')"
      >
        + New
      </button>
    </div>

    <!-- List -->
    <div class="flex-1 overflow-y-auto">
      <div
        v-for="p in sorted"
        :key="p.id"
        class="px-3 py-2.5 cursor-pointer border-b border-navy-900 hover:bg-navy-850 transition-colors"
        :class="[
          p.id === activeId ? 'bg-navy-800 border-l-2 border-l-cyan-600' : '',
          p.status !== 'running' && p.status !== 'starting' ? 'opacity-50' : '',
        ]"
        @click="router.push(`/processes/${p.id}`)"
      >
        <div class="flex items-center gap-2 min-w-0">
          <ProcessStatusDot :status="p.status" />
          <span class="text-xs text-slate-200 font-mono truncate flex-1">
            {{ p.name ?? p.command }}
          </span>
        </div>
        <div class="mt-0.5 pl-4 text-[10px] text-navy-500 truncate">
          {{ elapsed(p) }}
          <span v-if="p.exitCode !== null"> · exit {{ p.exitCode }}</span>
        </div>
      </div>

      <div v-if="sorted.length === 0" class="px-3 py-6 text-xs text-navy-600 text-center">
        No processes yet
      </div>
    </div>
  </div>
</template>
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/components/processes/ProcessList.vue
git commit -m "feat(web): add ProcessList component"
```

---

## Task 8: `ProcessDetail.vue`

**Files:**

- Create: `packages/web/src/components/processes/ProcessDetail.vue`

- [ ] **Step 1: Implement `ProcessDetail.vue`**

Create `packages/web/src/components/processes/ProcessDetail.vue`:

```vue
<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { useProcess } from '../../composables/useProcess.js';
import ProcessStatusDot from './ProcessStatusDot.vue';
import AnsiOutput from './AnsiOutput.vue';

const props = defineProps<{ processId: string }>();
const emit = defineEmits<{ deleted: [] }>();

const { handle, chunks, error, stop, send, del } = useProcess(props.processId);

// Elapsed timer
const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | null = null;

function startTimer(): void {
  if (!timer)
    timer = setInterval(() => {
      now.value = Date.now();
    }, 1000);
}
function stopTimer(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

watch(
  () => handle.value?.status,
  (status) => {
    if (status === 'running') startTimer();
    else stopTimer();
  },
  { immediate: true },
);

onUnmounted(stopTimer);

const elapsed = computed(() => {
  if (!handle.value) return '';
  const start = new Date(handle.value.startedAt).getTime();
  const end = handle.value.exitedAt ? new Date(handle.value.exitedAt).getTime() : now.value;
  const s = Math.floor((end - start) / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
});

const isRunning = computed(() => handle.value?.status === 'running');

// Stdin
const stdinInput = ref('');
const sending = ref(false);
const stopping = ref(false);
const deleting = ref(false);

async function onSend(): Promise<void> {
  if (!stdinInput.value) return;
  sending.value = true;
  try {
    await send(stdinInput.value);
    stdinInput.value = '';
  } finally {
    sending.value = false;
  }
}

async function onStop(): Promise<void> {
  stopping.value = true;
  try {
    await stop();
  } finally {
    stopping.value = false;
  }
}

async function onDelete(): Promise<void> {
  deleting.value = true;
  try {
    await del();
    emit('deleted');
  } finally {
    deleting.value = false;
  }
}
</script>

<template>
  <div class="flex flex-col h-full min-h-0">
    <!-- Loading state -->
    <div
      v-if="!handle && !error"
      class="flex-1 flex items-center justify-center text-navy-600 text-xs"
    >
      Loading…
    </div>

    <!-- Error state -->
    <div v-else-if="error" class="flex-1 flex items-center justify-center text-red-400 text-xs">
      {{ error }}
    </div>

    <!-- Detail view -->
    <template v-else-if="handle">
      <!-- Header bar -->
      <div class="flex items-center gap-3 px-4 py-2.5 border-b border-navy-700 flex-shrink-0">
        <ProcessStatusDot :status="handle.status" />
        <span class="text-xs font-semibold text-slate-100 font-mono truncate">
          {{ handle.name ?? handle.command }}
          <span v-if="handle.args.length" class="text-navy-400 font-normal">
            {{ handle.args.join(' ') }}</span
          >
        </span>
        <span class="text-[10px] text-navy-500">pid {{ handle.pid }}</span>
        <span class="text-[10px] text-navy-500">{{ elapsed }}</span>
        <span
          v-if="handle.exitCode !== null"
          class="text-[10px]"
          :class="handle.exitCode === 0 ? 'text-green-400' : 'text-red-400'"
        >
          exit {{ handle.exitCode }}
        </span>

        <div class="ml-auto flex items-center gap-2">
          <button
            :disabled="!isRunning || stopping"
            class="text-xs px-3 py-1 rounded border transition-colors"
            :class="
              isRunning
                ? 'border-red-500/40 text-red-400 hover:bg-red-950/30'
                : 'border-navy-700 text-navy-600 cursor-not-allowed'
            "
            @click="onStop"
          >
            {{ stopping ? 'Stopping…' : '■ Stop' }}
          </button>
          <button
            :disabled="isRunning || deleting"
            class="text-xs px-3 py-1 rounded border transition-colors"
            :class="
              !isRunning
                ? 'border-navy-600 text-navy-400 hover:text-slate-300 hover:border-navy-500'
                : 'border-navy-800 text-navy-700 cursor-not-allowed'
            "
            @click="onDelete"
          >
            {{ deleting ? 'Deleting…' : 'Delete' }}
          </button>
        </div>
      </div>

      <!-- Terminal output -->
      <AnsiOutput :chunks="chunks" class="flex-1 min-h-0" />

      <!-- Stdin footer — only when running -->
      <div
        v-if="isRunning"
        class="flex items-center gap-2 px-4 py-2.5 border-t border-navy-700 flex-shrink-0"
      >
        <input
          v-model="stdinInput"
          placeholder="stdin…"
          class="flex-1 bg-navy-950 border border-navy-700 rounded px-3 py-1.5 text-xs text-slate-200 outline-none focus:border-cyan-400/50 font-mono"
          @keydown.enter="onSend"
        />
        <button
          :disabled="!stdinInput || sending"
          class="text-xs px-3 py-1.5 rounded border border-navy-600 text-navy-300 hover:text-slate-200 hover:border-navy-500 disabled:opacity-40"
          @click="onSend"
        >
          Send
        </button>
      </div>
    </template>
  </div>
</template>
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/components/processes/ProcessDetail.vue
git commit -m "feat(web): add ProcessDetail component"
```

---

## Task 9: `ProcessesView.vue`

**Files:**

- Create: `packages/web/src/views/ProcessesView.vue`

- [ ] **Step 1: Implement `ProcessesView.vue`**

Create `packages/web/src/views/ProcessesView.vue`:

```vue
<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppLayout from '../components/layout/AppLayout.vue';
import ProcessList from '../components/processes/ProcessList.vue';
import ProcessStartForm from '../components/processes/ProcessStartForm.vue';
import ProcessDetail from '../components/processes/ProcessDetail.vue';
import { useProcesses } from '../composables/useProcesses.js';

const route = useRoute();
const router = useRouter();
const { processes, refresh } = useProcesses();

const activeId = computed(() => (route.params.id as string | undefined) ?? null);

async function onStarted(id: string): Promise<void> {
  await refresh();
  await router.push(`/processes/${id}`);
}

async function onDeleted(): Promise<void> {
  await refresh();
  await router.push('/processes');
}
</script>

<template>
  <AppLayout>
    <div class="flex h-full">
      <!-- Left: process list sidebar -->
      <div class="w-52 flex-shrink-0 border-r border-navy-800 flex flex-col">
        <ProcessList :processes="processes" :active-id="activeId" />
      </div>

      <!-- Right: start form or process detail -->
      <div class="flex-1 flex flex-col min-w-0">
        <ProcessDetail
          v-if="activeId"
          :key="activeId"
          :process-id="activeId"
          @deleted="onDeleted"
        />
        <ProcessStartForm v-else @started="onStarted" />
      </div>
    </div>
  </AppLayout>
</template>
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/views/ProcessesView.vue
git commit -m "feat(web): add ProcessesView"
```

---

## Task 10: Router + Sidebar wiring

**Files:**

- Modify: `packages/web/src/router/index.ts`
- Modify: `packages/web/src/components/layout/AppSidebar.vue`

- [ ] **Step 1: Add routes to `router/index.ts`**

Current `routes` array in `packages/web/src/router/index.ts`:

```typescript
const routes = [
  { path: '/login', component: () => import('../views/LoginView.vue') },
  { path: '/', redirect: '/participants' },
  {
    path: '/participants',
    component: () => import('../views/ParticipantsView.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/conversations',
    component: () => import('../views/ConversationsView.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/conversations/new',
    component: () => import('../views/ConversationsView.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/conversations/:id',
    component: () => import('../views/ConversationsView.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/events',
    component: () => import('../views/EventStreamView.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/config',
    component: () => import('../views/ConfigView.vue'),
    meta: { requiresAuth: true },
  },
];
```

Add process routes after `/conversations/:id` and before `/events`:

```typescript
  {
    path: '/processes',
    component: () => import('../views/ProcessesView.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/processes/:id',
    component: () => import('../views/ProcessesView.vue'),
    meta: { requiresAuth: true },
  },
```

- [ ] **Step 2: Add Processes to sidebar nav**

Current `nav` array in `packages/web/src/components/layout/AppSidebar.vue`:

```typescript
const nav = [
  { label: 'Participants', icon: '👤', to: '/participants' },
  { label: 'Conversations', icon: '💬', to: '/conversations' },
  { label: 'Events', icon: '⚡', to: '/events' },
  { label: 'Config', icon: '⚙️', to: '/config' },
];
```

Add Processes between Events and Config:

```typescript
const nav = [
  { label: 'Participants', icon: '👤', to: '/participants' },
  { label: 'Conversations', icon: '💬', to: '/conversations' },
  { label: 'Events', icon: '⚡', to: '/events' },
  { label: 'Processes', icon: '⚙', to: '/processes' },
  { label: 'Config', icon: '⚙️', to: '/config' },
];
```

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/router/index.ts packages/web/src/components/layout/AppSidebar.vue
git commit -m "feat(web): add /processes routes and sidebar nav entry"
```

---

## Task 11: Final verification

- [ ] **Step 1: Format**

```bash
npm run format
```

- [ ] **Step 2: Format check**

```bash
npm run format:check
```

Expected: no issues.

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 4: Web package tests**

```bash
npm run test --workspace=packages/web
```

Expected: all tests pass including the new process tests. No regressions in existing tests.

- [ ] **Step 5: Root unit tests (no regressions)**

```bash
npm test
```

Expected: all core/runtime/types tests pass.

- [ ] **Step 6: Build**

```bash
npm run build
```

Expected: clean build, no errors.

- [ ] **Step 7: Final commit**

```bash
git add -A
git commit -m "feat(web): process management UI — list, detail, terminal output, start form"
```

---

## Self-Review

### Spec coverage check

| Spec requirement                                                             | Task    |
| ---------------------------------------------------------------------------- | ------- |
| `/processes` + `/processes/:id` routes                                       | Task 10 |
| `ProcessesView` — split view orchestrator                                    | Task 9  |
| `ProcessList` — left sidebar, all statuses, sorted by startedAt desc         | Task 7  |
| `ProcessStatusDot` — colour per status                                       | Task 2  |
| `ProcessStartForm` — command/args/name/cwd/tty/shell, always `start_process` | Task 6  |
| `ProcessDetail` — terminal-first, header bar, AnsiOutput, stdin footer       | Task 8  |
| `AnsiOutput` — owns `AnsiUp` instance, scroll-lock, scroll-to-bottom button  | Task 3  |
| `useProcesses` — list fetching, 5s polling, singleton                        | Task 4  |
| `useProcess` — handle, chunks (raw strings), WS subscription, stop/send/del  | Task 5  |
| `ansi_up` dependency                                                         | Task 1  |
| Sidebar nav entry                                                            | Task 10 |
| `:key="activeId"` on `ProcessDetail` (destroy/recreate)                      | Task 9  |
| `read_process_output` with `decode: 'base64'` on mount                       | Task 5  |
| `subscribe_process` / `unsubscribe_process` WS messages                      | Task 5  |
| `process:output` → `atob` → push to chunks                                   | Task 5  |
| `process:exited` → update handle status + exitCode                           | Task 5  |
| Elapsed timer (live for running, final for stopped)                          | Task 8  |
| Stop button disabled when not running                                        | Task 8  |
| Delete button disabled when running                                          | Task 8  |
| Stdin footer hidden when not running                                         | Task 8  |

### Placeholder scan

None found. All steps contain actual code.

### Type consistency check

- `chunks: string[]` defined in `useProcess` Task 5, consumed as `chunks: string[]` prop in `AnsiOutput` Task 3 — consistent.
- `handle: Ref<ProcessHandle | null>` from `useProcess`, used in `ProcessDetail` as `handle.value?.status` — consistent.
- `emit('started', handle.id)` in `ProcessStartForm` Task 6, handled as `onStarted(id: string)` in `ProcessesView` Task 9 — consistent.
- `emit('deleted')` in `ProcessDetail` Task 8, handled as `onDeleted()` in `ProcessesView` Task 9 — consistent.
- `useProcesses()` returns `{ processes, loading, error, refresh }` Task 4, used in `ProcessesView` Task 9 as `const { processes, refresh } = useProcesses()` — consistent.
- `execute('list_processes', { status: 'all' })` in `useProcesses` Task 4 — matches backend tool schema.
- `execute('read_process_output', { id, bytes: 65536, decode: 'base64' })` in `useProcess` Task 5 — matches backend tool schema.
