/**
 * Transport-internal stream lifecycle tracker. Holds one AbortController per
 * active stream. Never exposed to ToolRegistry callers or tool authors.
 */
export class StreamRegistry {
  private streams = new Map<
    string,
    { connectionId: string; participantId: string; abort: AbortController }
  >();

  /**
   * Register a new stream. Returns an AbortSignal the tool generator can
   * poll or pass to AsyncQueue.next() to detect cancellation.
   */
  register(streamId: string, connectionId: string, participantId: string): AbortSignal {
    const controller = new AbortController();
    this.streams.set(streamId, { connectionId, participantId, abort: controller });
    return controller.signal;
  }

  /**
   * Cancel a specific stream if the participant owns it. Returns false if the
   * stream is unknown or belongs to another participant.
   */
  cancelForParticipant(streamId: string, participantId: string): boolean {
    const entry = this.streams.get(streamId);
    if (!entry || entry.participantId !== participantId) return false;
    entry.abort.abort();
    this.streams.delete(streamId);
    return true;
  }

  /**
   * Cancel all streams for a connection — called on WS socket close.
   */
  cancelAll(connectionId: string): void {
    for (const [streamId, entry] of this.streams) {
      if (entry.connectionId === connectionId) {
        entry.abort.abort();
        this.streams.delete(streamId);
      }
    }
  }
}
