import type { FailureMode } from '@legion/types';

export interface MiddlewareSchemaNode {
  type?: string;
  title?: string;
  description?: string;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  uniqueItems?: boolean;
  format?: string;
  items?: MiddlewareSchemaNode;
  properties?: Record<string, MiddlewareSchemaNode>;
  required?: string[];
}

export interface MiddlewareDefinitionInfo {
  type: string;
  displayName: string;
  description?: string;
  defaultFailureMode: FailureMode;
  configSchema: MiddlewareSchemaNode;
  source: string;
}

export interface MiddlewareDiagnosticInfo {
  type: string;
  source: string;
  status: 'loaded' | 'error';
  error?: string;
  configurationErrors: Array<{ participantId: string; instanceId: string; errors: string[] }>;
}

export interface SkillInfo {
  name: string;
  description: string;
  scope: string;
  location: string;
  baseDirectory: string;
}
