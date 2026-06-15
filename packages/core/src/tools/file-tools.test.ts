import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileReadTool, fileWriteTool, fileListTool } from './file-tools.js';
import type { ToolContext } from './Tool.js';

function ctx(workspaceRoot: string): ToolContext {
  return {
    workspaceRoot,
    participant: { id: 'p', name: 'P', type: 'mock', tools: {}, responses: [] },
  } as unknown as ToolContext;
}

describe('file tools', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'legion-files-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('file_write then file_read round-trips', async () => {
    const w = await fileWriteTool.execute({ path: 'notes/a.txt', content: 'hello' }, ctx(dir));
    expect(w.status).toBe('success');
    const r = await fileReadTool.execute({ path: 'notes/a.txt' }, ctx(dir));
    expect(r).toEqual({ status: 'success', data: 'hello' });
  });

  it('file_read returns an error for a missing file', async () => {
    const r = await fileReadTool.execute({ path: 'missing.txt' }, ctx(dir));
    expect(r.status).toBe('error');
  });

  it('file_list lists directory entries', async () => {
    await fileWriteTool.execute({ path: 'd/a.txt', content: '1' }, ctx(dir));
    await fileWriteTool.execute({ path: 'd/b.txt', content: '2' }, ctx(dir));
    const r = await fileListTool.execute({ path: 'd' }, ctx(dir));
    expect(r.status).toBe('success');
    expect((r.data as string[]).sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('rejects path traversal outside the workspace', async () => {
    const r = await fileReadTool.execute({ path: '../../etc/passwd' }, ctx(dir));
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/outside|invalid path/i);
  });
});
