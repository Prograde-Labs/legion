import type {
  AgentConfig,
  BaseParticipant,
  CommunicationConfig,
  WorkspaceConfig,
} from '../src/index.js';

type Equal<TLeft, TRight> =
  (<T>() => T extends TLeft ? 1 : 2) extends <T>() => T extends TRight ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
type IsOptional<T, TKey extends keyof T> = {} extends Pick<T, TKey> ? true : false;

type CommunicationIsOptional = Expect<Equal<IsOptional<WorkspaceConfig, 'communication'>, true>>;
type ReplyTimeoutIsOptional = Expect<Equal<IsOptional<BaseParticipant, 'replyTimeoutMs'>, true>>;

const workspace = {
  version: '2',
  communication: { replyTimeoutMs: null },
} satisfies WorkspaceConfig;

const agent = {
  id: 'agent-1',
  name: 'Agent',
  type: 'agent',
  tools: {},
  systemPrompt: 'You are helpful.',
  model: { model: 'gpt-4o-mini' },
  maxIterations: 10,
  replyTimeoutMs: 60_000,
} satisfies AgentConfig;

const communication: CommunicationConfig = { replyTimeoutMs: 1000 };

void [
  workspace,
  agent,
  communication,
  null as unknown as CommunicationIsOptional,
  null as unknown as ReplyTimeoutIsOptional,
];
