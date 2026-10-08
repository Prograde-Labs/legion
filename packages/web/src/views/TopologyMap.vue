<script setup lang="ts">
// OQ1 (default accepted): connector nodes omitted — no tool exposes connector
// config; adding one would be a seventh backend change (plan tripwire).
// OQ2 (default accepted): deterministic type-grouped circular layout; no physics.
// Live WS edges: the reducer below is the same one an activity subscription
// would call; subscribing live is deferred (TODO(task-22) e2e verification).
// (Ledger: brief placed these as an HTML comment inside <script setup>, which is
// invalid TS — converted to TS comments, content unchanged.)
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useLegionApi } from '../composables/useLegionApi.js';
import { useParticipants } from '../composables/useParticipants.js';

const emit = defineEmits<{ select: [participantId: string] }>();

const { participants } = useParticipants();
const { execute, onEvent } = useLegionApi();

interface McpSource {
  name: string;
}

const mcpSources = ref<McpSource[]>([]);

async function loadMcp(): Promise<void> {
  try {
    mcpSources.value = await execute<McpSource[]>('list_mcp_sources', {});
  } catch {
    mcpSources.value = [];
  }
}

onMounted(() => void loadMcp());

interface TopoNode {
  id: string;
  label: string;
  kind: 'agent' | 'user' | 'service' | 'mock' | 'mcp';
  x: number;
  y: number;
}

const WIDTH = 640;
const HEIGHT = 420;
const CENTER_X = WIDTH / 2;
const CENTER_Y = HEIGHT / 2;

const nodes = computed<TopoNode[]>(() => {
  const order: Array<TopoNode['kind']> = ['agent', 'user', 'service', 'mock'];
  const groups = new Map<string, typeof participants.value>();
  for (const p of participants.value) {
    const list = groups.get(p.type) ?? [];
    list.push(p);
    groups.set(p.type, list);
  }
  const result: TopoNode[] = [];
  const ringCount = groups.size + (mcpSources.value.length > 0 ? 1 : 0) || 1;
  let ringIndex = 0;
  for (const kind of order) {
    const group = groups.get(kind);
    if (!group?.length) continue;
    const angle = (2 * Math.PI * ringIndex) / ringCount;
    const cx = CENTER_X + Math.cos(angle) * 170;
    const cy = CENTER_Y + Math.sin(angle) * 130;
    group.forEach((p, i) => {
      const spread = (2 * Math.PI * i) / group.length;
      result.push({
        id: p.id,
        label: p.name,
        kind: kind as TopoNode['kind'],
        x: cx + Math.cos(spread) * 60,
        y: cy + Math.sin(spread) * 45,
      });
    });
    ringIndex += 1;
  }
  if (mcpSources.value.length > 0) {
    const angle = (2 * Math.PI * ringIndex) / ringCount;
    mcpSources.value.forEach((s, i) => {
      const spread = (2 * Math.PI * i) / mcpSources.value.length;
      result.push({
        id: `mcp:${s.name}`,
        label: s.name,
        kind: 'mcp',
        x: CENTER_X + Math.cos(angle) * 170 + Math.cos(spread) * 60,
        y: CENTER_Y + Math.sin(angle) * 130 + Math.sin(spread) * 45,
      });
    });
  }
  return result;
});

// ---- live edges (5s decay) ----
const edges = ref<Map<string, number>>(new Map());
let pruneTimer: ReturnType<typeof setInterval> | null = null;

function handleActivity(activity: { participantId?: string }): void {
  const from = activity.participantId;
  if (!from) return;
  // Edge: actor -> each MCP node it may touch is unknown; simplest live signal:
  // an edge from the actor to the collective center hub (id 'hub').
  const key = `${from}->hub`;
  edges.value = new Map(edges.value).set(key, Date.now());
}

function prune(): void {
  const cutoff = Date.now() - 5000;
  const next = new Map<string, number>();
  for (const [key, seen] of edges.value) {
    if (seen > cutoff) next.set(key, seen);
  }
  edges.value = next;
}

onMounted(() => {
  pruneTimer = setInterval(prune, 1000);
  onEvent('activity', (data) => handleActivity(data as { participantId?: string }));
});

onBeforeUnmount(() => {
  if (pruneTimer) clearInterval(pruneTimer);
});

const liveEdges = computed(() =>
  [...edges.value.entries()].map(([key, seen]) => {
    const from = key.split('->')[0]!;
    const node = nodes.value.find((n) => n.id === from);
    const age = Math.min(1, (Date.now() - seen) / 5000);
    return {
      key,
      x1: node?.x ?? CENTER_X,
      y1: node?.y ?? CENTER_Y,
      x2: CENTER_X,
      y2: CENTER_Y,
      opacity: 1 - age,
    };
  }),
);

function nodeFill(kind: TopoNode['kind']): string {
  if (kind === 'mcp') return 'var(--color-surface-raised)';
  if (kind === 'user') return 'var(--color-accent-soft)';
  return 'var(--color-surface)';
}

defineExpose({
  __handleActivityForTests: handleActivity,
});
</script>

<template>
  <div class="flex h-full flex-col">
    <svg
      data-test="topo-svg"
      :viewBox="`0 0 ${WIDTH} ${HEIGHT}`"
      class="h-full w-full"
      role="img"
      aria-label="Collective topology"
    >
      <line
        v-for="edge in liveEdges"
        :key="edge.key"
        data-test="topo-edge"
        :x1="edge.x1"
        :y1="edge.y1"
        :x2="edge.x2"
        :y2="edge.y2"
        stroke="var(--color-accent)"
        :stroke-opacity="edge.opacity"
        stroke-width="1.5"
      />
      <g
        v-for="node in nodes"
        :key="node.id"
        data-test="topo-node"
        role="button"
        @click="node.kind !== 'mcp' && emit('select', node.id)"
      >
        <circle
          :cx="node.x"
          :cy="node.y"
          r="18"
          :fill="nodeFill(node.kind)"
          stroke="var(--color-line)"
        />
        <text
          :x="node.x"
          :y="node.y + 32"
          text-anchor="middle"
          class="fill-current text-[10px] text-muted"
        >
          {{ node.label }}
        </text>
        <title>{{ node.label }} ({{ node.kind }})</title>
      </g>
      <circle
        :cx="CENTER_X"
        :cy="CENTER_Y"
        r="10"
        fill="var(--color-accent-soft)"
        stroke="var(--color-accent)"
      />
    </svg>
  </div>
</template>
