import type { ChildProcess } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import type { Writable } from 'node:stream';
import type { IPty } from 'node-pty';
import type { ProcessMeta } from '@legion-collective/types';
import type { RingBuffer } from './RingBuffer.js';

/**
 * Internal per-process handle. Never exposed outside ProcessManager.
 * Callers receive ProcessHandle (a frozen snapshot of public fields).
 */
export interface ProcessEntry {
  meta: ProcessMeta;
  /** null after exit */
  child: ChildProcess | IPty | null;
  /** Per-process event channel. Subscribers attach via ProcessManager.subscribe(). */
  emitter: EventEmitter;
  ringBuffer: RingBuffer;
  /** Append stream to .legion/processes/<id>/output.log. null after close. */
  logStream: Writable | null;
  /** Running total bytes written to output.log. Used for totalBytes in readOutput(). */
  logByteCount: number;
}
