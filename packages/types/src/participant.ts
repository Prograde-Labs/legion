import type { ToolPolicy, ApprovalAuthority } from './tool.js';
import type { ModelConfig } from './config.js';

export type ParticipantType = 'agent' | 'service' | 'user' | 'mock';
export type ParticipantStatus = 'active' | 'retired';

export interface ConnectorIdentity {
  connector: string;
  externalId: string;
}

export interface BaseParticipant {
  id: string;
  name: string;
  type: ParticipantType;
  tools: Record<string, ToolPolicy>;
  approvalAuthority?: ApprovalAuthority;
  status?: ParticipantStatus;
  identities?: ConnectorIdentity[];
  operator?: boolean;
  protected?: boolean;
}

export interface AgentConfig extends BaseParticipant {
  type: 'agent';
  model: ModelConfig;
  systemPrompt: string;
  maxIterations: number;
  runtimeConfig?: Record<string, unknown>;
}

export interface ServiceConfig extends BaseParticipant {
  type: 'service';
  module: string;
  config?: Record<string, unknown>;
  canReceive?: boolean;
  autoStart?: boolean;
  /**
   * Participant ID to notify when this service fails to start or crashes during onMessage.
   * ServiceManager sends the error details as a message to this participant.
   */
  errorNotify?: string;
}

export interface UserConfig extends BaseParticipant {
  type: 'user';
}

export interface MockConfig extends BaseParticipant {
  type: 'mock';
  responses: string[];
}

export type ParticipantConfig = AgentConfig | ServiceConfig | UserConfig | MockConfig;
