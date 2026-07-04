import type { Storage } from '../storage/Storage.js';
import type { ProcessMeta } from '@legion/types';

function metaKey(id: string): string {
  return `${id}/meta.json`;
}

export async function writeMeta(storage: Storage, meta: ProcessMeta): Promise<void> {
  await storage.writeJson(metaKey(meta.id), meta);
}

export async function readMeta(storage: Storage, id: string): Promise<ProcessMeta | null> {
  try {
    return await storage.readJson<ProcessMeta>(metaKey(id));
  } catch {
    return null;
  }
}

export async function listProcessIds(storage: Storage): Promise<string[]> {
  // storage.list('') is non-recursive: returns per-process directory names.
  // Filter to entries that have a meta.json inside (defensive: skips stray files).
  const candidates = await storage.list('');
  const ids: string[] = [];
  for (const candidate of candidates) {
    if (await storage.exists(`${candidate}/meta.json`)) {
      ids.push(candidate);
    }
  }
  return ids;
}
