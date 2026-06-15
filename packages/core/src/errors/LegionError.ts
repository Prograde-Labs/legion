export class LegionError extends Error {
  readonly code: string;

  constructor(message: string, code = 'LEGION_ERROR') {
    super(message);
    this.name = new.target.name;
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ParticipantNotFoundError extends LegionError {
  constructor(participantId: string) {
    super(`Participant not found: ${participantId}`, 'PARTICIPANT_NOT_FOUND');
  }
}

export class ToolNotFoundError extends LegionError {
  constructor(toolName: string) {
    super(`Tool not found: ${toolName}`, 'TOOL_NOT_FOUND');
  }
}

export class ProviderError extends LegionError {
  constructor(message: string) {
    super(message, 'PROVIDER_ERROR');
  }
}

export class ConfigError extends LegionError {
  constructor(message: string) {
    super(message, 'CONFIG_ERROR');
  }
}

export class ConversationNotFoundError extends LegionError {
  constructor(conversationId: string, messageId?: string) {
    const msg = messageId
      ? `Conversation not found: ${conversationId}#${messageId}`
      : `Conversation not found: ${conversationId}`;
    super(msg, 'CONVERSATION_NOT_FOUND');
  }
}

export class AuthorizationError extends LegionError {
  constructor(message: string) {
    super(message, 'AUTHORIZATION_ERROR');
  }
}
