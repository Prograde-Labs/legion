export type ProcessStatus = 'starting' | 'running' | 'exited' | 'killed' | 'abandoned';

export interface ProcessMeta {
  id: string;
  name?: string;
  command: string;
  args: string[];
  cwd: string;
  tty: boolean;
  shell: boolean;
  startedAt: string; // ISO-8601
  startedByParticipantId: string;
  pid: number;
  status: ProcessStatus;
  exitCode: number | null;
  exitedAt: string | null; // ISO-8601; null if running or abandoned without clean exit
  abandonedReason?: 'parent_unclean_shutdown';
}

export interface ProcessHandle {
  id: string;
  name?: string;
  command: string;
  args: string[];
  cwd: string;
  tty: boolean;
  shell: boolean;
  startedAt: string;
  startedByParticipantId: string;
  pid: number;
  status: ProcessStatus;
  exitCode: number | null;
  exitedAt: string | null;
}

export interface ExecuteResult {
  processId: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface ProcessOutputChunk {
  id: string;
  stream: 'stdout' | 'stderr' | 'combined'; // 'combined' in PTY mode
  data: Buffer;
  timestamp: string;
}

export interface SpawnConfig {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  tty?: boolean;
  shell?: boolean;
  name?: string;
  cols?: number; // tty only, default 80
  rows?: number; // tty only, default 24
}
