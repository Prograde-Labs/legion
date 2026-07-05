import { describe, it, expect } from 'vitest';
import { isRelevantToParticipant } from './event-filter.js';

describe('isRelevantToParticipant', () => {
  const pid = 'operator';
  const isOperator = true;

  it('always passes process:ready', () => {
    expect(isRelevantToParticipant('process:ready', {}, pid, false)).toBe(true);
  });

  it('always passes conversation:created', () => {
    expect(
      isRelevantToParticipant('conversation:created', { conversationId: 'c1' }, pid, false),
    ).toBe(true);
  });

  it('always passes participant:active and participant:retired', () => {
    expect(isRelevantToParticipant('participant:active', { participantId: 'x' }, pid, false)).toBe(
      true,
    );
    expect(isRelevantToParticipant('participant:retired', { participantId: 'x' }, pid, false)).toBe(
      true,
    );
  });

  it('always passes error', () => {
    expect(isRelevantToParticipant('error', { message: 'oops' }, pid, false)).toBe(true);
  });

  it('passes message:sent when senderId matches', () => {
    expect(
      isRelevantToParticipant(
        'message:sent',
        { senderId: pid, recipientId: 'agent-1', conversationId: 'c1', messageId: 'm1' },
        pid,
        false,
      ),
    ).toBe(true);
  });

  it('passes message:sent when recipientId matches', () => {
    expect(
      isRelevantToParticipant(
        'message:sent',
        { senderId: 'agent-1', recipientId: pid, conversationId: 'c1', messageId: 'm1' },
        pid,
        false,
      ),
    ).toBe(true);
  });

  it('drops message:sent for unrelated participants', () => {
    expect(
      isRelevantToParticipant(
        'message:sent',
        { senderId: 'agent-1', recipientId: 'agent-2', conversationId: 'c1', messageId: 'm1' },
        pid,
        false,
      ),
    ).toBe(false);
  });

  it('passes message:delivered when recipientId matches', () => {
    expect(
      isRelevantToParticipant(
        'message:delivered',
        { recipientId: pid, conversationId: 'c1', messageId: 'm1' },
        pid,
        false,
      ),
    ).toBe(true);
  });

  it('drops message:delivered for other recipients', () => {
    expect(
      isRelevantToParticipant(
        'message:delivered',
        { recipientId: 'agent-1', conversationId: 'c1', messageId: 'm1' },
        pid,
        false,
      ),
    ).toBe(false);
  });

  it('passes tool:call when participantId matches', () => {
    expect(
      isRelevantToParticipant(
        'tool:call',
        { participantId: pid, conversationId: 'c1', toolName: 'x', toolCallId: 't1' },
        pid,
        false,
      ),
    ).toBe(true);
  });

  it('drops tool:call for other participants', () => {
    expect(
      isRelevantToParticipant(
        'tool:call',
        { participantId: 'agent-1', conversationId: 'c1', toolName: 'x', toolCallId: 't1' },
        pid,
        false,
      ),
    ).toBe(false);
  });

  it('passes tool:result when participantId matches', () => {
    expect(
      isRelevantToParticipant(
        'tool:result',
        {
          participantId: pid,
          conversationId: 'c1',
          toolName: 'x',
          toolCallId: 't1',
          result: { status: 'success', data: null },
        },
        pid,
        false,
      ),
    ).toBe(true);
  });

  it('passes iteration when participantId matches', () => {
    expect(
      isRelevantToParticipant(
        'iteration',
        { participantId: pid, conversationId: 'c1', iteration: 0 },
        pid,
        false,
      ),
    ).toBe(true);
  });

  it('drops iteration for other participants', () => {
    expect(
      isRelevantToParticipant(
        'iteration',
        { participantId: 'agent-1', conversationId: 'c1', iteration: 0 },
        pid,
        false,
      ),
    ).toBe(false);
  });

  it('passes approval:requested for operators regardless of requesterId', () => {
    expect(
      isRelevantToParticipant(
        'approval:requested',
        { approvalId: 'a1', requesterId: 'agent-1', conversationId: 'c1', toolName: 'x', args: {} },
        pid,
        true,
      ),
    ).toBe(true);
  });

  it('drops approval:requested for non-operators who are not the requester', () => {
    expect(
      isRelevantToParticipant(
        'approval:requested',
        { approvalId: 'a1', requesterId: 'agent-1', conversationId: 'c1', toolName: 'x', args: {} },
        'agent-2',
        false,
      ),
    ).toBe(false);
  });

  it('passes approval:requested to the requester themselves', () => {
    expect(
      isRelevantToParticipant(
        'approval:requested',
        { approvalId: 'a1', requesterId: pid, conversationId: 'c1', toolName: 'x', args: {} },
        pid,
        false,
      ),
    ).toBe(true);
  });

  it('passes approval:resolved for operators', () => {
    expect(
      isRelevantToParticipant(
        'approval:resolved',
        { approvalId: 'a1', requesterId: 'agent-1', conversationId: 'c1', approved: true },
        pid,
        true,
      ),
    ).toBe(true);
  });

  it('drops unknown event types', () => {
    expect(isRelevantToParticipant('unknown:event' as any, {}, pid, false)).toBe(false);
  });
});
