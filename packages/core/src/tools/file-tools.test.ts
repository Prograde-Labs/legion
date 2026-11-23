import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileReadTool, fileWriteTool, fileEditTool, fileListTool } from './file-tools.js';
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
    expect(r.status).toBe('success');
    expect(r.data).toEqual({ path: 'notes/a.txt', offset: 1, lineCount: 1, content: 'hello' });
    expect(r.content).toBe('Read file notes/a.txt, lines 1-1\n1: hello');
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

  it('accepts an absolute path inside the workspace root', async () => {
    await mkdir(join(dir, 'inside'), { recursive: true });
    await writeFile(join(dir, 'inside', 'a.txt'), 'hello');
    const r = await fileReadTool.execute({ path: join(dir, 'inside', 'a.txt') }, ctx(dir));
    expect(r.status).toBe('success');
    expect((r.data as { content: string }).content).toBe('hello');
  });

  it('rejects an absolute path outside the workspace root', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'legion-outside-'));
    try {
      await writeFile(join(outside, 'a.txt'), 'outside');
      const r = await fileReadTool.execute({ path: join(outside, 'a.txt') }, ctx(dir));
      expect(r.status).toBe('error');
      expect(r.error).toMatch(/outside/i);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects an absolute path that escapes with ..', async () => {
    const r = await fileReadTool.execute({ path: `${dir}/../escape.txt` }, ctx(dir));
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/outside/i);
  });

  describe('file_read', () => {
    it('returns structured data and numbered model content', async () => {
      await writeFile(join(dir, 'a.txt'), 'one\ntwo\n');
      const r = await fileReadTool.execute({ path: 'a.txt' }, ctx(dir));
      expect(r.status).toBe('success');
      expect(r.data).toEqual({ path: 'a.txt', offset: 1, lineCount: 2, content: 'one\ntwo' });
      expect(r.content).toBe('Read file a.txt, lines 1-2\n1: one\n2: two');
    });

    it('pages with offset and limit and sets next when lines remain', async () => {
      await writeFile(join(dir, 'n.txt'), 'a\nb\nc\nd\n');
      const r = await fileReadTool.execute({ path: 'n.txt', offset: 2, limit: 2 }, ctx(dir));
      expect(r.data).toEqual({
        path: 'n.txt',
        offset: 2,
        lineCount: 2,
        next: 4,
        content: 'b\nc',
      });
      expect(r.content).toBe(
        'Read file n.txt, lines 2-3\n2: b\n3: c\n[Output truncated. Continue reading with offset: 4]',
      );
    });

    it('does not count a trailing newline as an extra line', async () => {
      await writeFile(join(dir, 't.txt'), 'only\n');
      const r = await fileReadTool.execute({ path: 't.txt' }, ctx(dir));
      expect((r.data as { lineCount: number }).lineCount).toBe(1);
    });

    it('returns zero lines for an empty file', async () => {
      await writeFile(join(dir, 'e.txt'), '');
      const r = await fileReadTool.execute({ path: 'e.txt' }, ctx(dir));
      expect(r.data).toEqual({ path: 'e.txt', offset: 1, lineCount: 0, content: '' });
      expect(r.content).toBe('Read file e.txt, 0 lines');
    });

    it('reports an offset past the end', async () => {
      await writeFile(join(dir, 'p.txt'), 'a\nb\n');
      const r = await fileReadTool.execute({ path: 'p.txt', offset: 5 }, ctx(dir));
      expect(r.data).toEqual({ path: 'p.txt', offset: 5, lineCount: 0, content: '' });
      expect(r.content).toBe(
        'Read file p.txt, 0 lines (offset 5 is past the end; the file has 2 lines)',
      );
    });

    it('clamps very long lines', async () => {
      await writeFile(join(dir, 'long.txt'), 'x'.repeat(2500));
      const r = await fileReadTool.execute({ path: 'long.txt' }, ctx(dir));
      expect(r.content).toContain('... (line truncated to 2000 chars)');
      expect((r.data as { content: string }).content).toBe(
        `${'x'.repeat(2000)}... (line truncated to 2000 chars)`,
      );
    });

    it('truncates output over 50 KB on a line boundary and sets next', async () => {
      const line = 'y'.repeat(40);
      await writeFile(join(dir, 'big.txt'), Array.from({ length: 3000 }, () => line).join('\n'));
      const r = await fileReadTool.execute({ path: 'big.txt' }, ctx(dir));
      expect(r.status).toBe('success');
      const data = r.data as { lineCount: number; next?: number };
      expect(data.next).toBeGreaterThan(1);
      expect(data.lineCount).toBeLessThan(3000);
      expect(r.content).toContain('[Output truncated. Continue reading with offset:');
      expect(Buffer.byteLength(r.content as string, 'utf8')).toBeLessThanOrEqual(50 * 1024);
    });

    it('caps limit at 2000 lines even when a larger limit is requested', async () => {
      await writeFile(join(dir, 'many.txt'), Array.from({ length: 3000 }, () => 'z').join('\n'));
      const r = await fileReadTool.execute({ path: 'many.txt', limit: 5000 }, ctx(dir));
      expect(r.status).toBe('success');
      const data = r.data as { lineCount: number; next?: number };
      expect(data.lineCount).toBeLessThanOrEqual(2000);
      expect(data.next).toBeDefined();
    });

    it('rejects binary files', async () => {
      await writeFile(join(dir, 'bin.txt'), 'abc\u0000def');
      const r = await fileReadTool.execute({ path: 'bin.txt' }, ctx(dir));
      expect(r.error).toBe('Cannot read binary file: bin.txt');
    });

    it('reports a missing file', async () => {
      const r = await fileReadTool.execute({ path: 'missing.txt' }, ctx(dir));
      expect(r.error).toBe('File not found: missing.txt');
    });

    it('reports a directory and points at file_list', async () => {
      await mkdir(join(dir, 'd'), { recursive: true });
      const r = await fileReadTool.execute({ path: 'd' }, ctx(dir));
      expect(r.error).toBe('Path is a directory, use file_list: d');
    });

    it('rejects invalid offset and limit', async () => {
      const badOffset = await fileReadTool.execute({ path: 'x', offset: 0 }, ctx(dir));
      expect(badOffset.error).toBe('offset must be at least 1');
      const badLimit = await fileReadTool.execute({ path: 'x', limit: 0 }, ctx(dir));
      expect(badLimit.error).toBe('limit must be at least 1');
    });
  });

  describe('file_edit', () => {
    it('replaces a unique exact match', async () => {
      await writeFile(join(dir, 'a.txt'), 'const x = 1;\nconst y = 2;\n');
      const r = await fileEditTool.execute(
        { path: 'a.txt', oldString: 'const x = 1;', newString: 'const x = 10;' },
        ctx(dir),
      );
      expect(r.status).toBe('success');
      expect(r.data).toEqual({ path: 'a.txt', replacements: 1 });
      expect(r.content).toBe('Edited a.txt (1 replacement)');
      expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('const x = 10;\nconst y = 2;\n');
    });

    it('replaces every occurrence when replaceAll is true', async () => {
      await writeFile(join(dir, 'a.txt'), 'foo\nfoo\nfoo\n');
      const r = await fileEditTool.execute(
        { path: 'a.txt', oldString: 'foo', newString: 'bar', replaceAll: true },
        ctx(dir),
      );
      expect(r.status).toBe('success');
      expect(r.data).toEqual({ path: 'a.txt', replacements: 3 });
      expect(r.content).toBe('Edited a.txt (3 replacements)');
      expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('bar\nbar\nbar\n');
    });

    it('fails when oldString is not found', async () => {
      await writeFile(join(dir, 'a.txt'), 'hello\n');
      const r = await fileEditTool.execute(
        { path: 'a.txt', oldString: 'missing', newString: 'x' },
        ctx(dir),
      );
      expect(r.error).toBe(
        'Could not find oldString in a.txt. It must match exactly, including whitespace and indentation.',
      );
    });

    it('fails on multiple matches without replaceAll', async () => {
      await writeFile(join(dir, 'a.txt'), 'foo foo\n');
      const r = await fileEditTool.execute(
        { path: 'a.txt', oldString: 'foo', newString: 'bar' },
        ctx(dir),
      );
      expect(r.error).toBe(
        'Found 2 matches for oldString, but expected exactly one. Add more surrounding context to make oldString unique, or set replaceAll to true.',
      );
    });

    it('fails when oldString and newString are identical', async () => {
      await writeFile(join(dir, 'a.txt'), 'hello\n');
      const r = await fileEditTool.execute(
        { path: 'a.txt', oldString: 'hello', newString: 'hello' },
        ctx(dir),
      );
      expect(r.error).toBe('No changes to apply: oldString and newString are identical.');
    });

    it('fails when oldString is empty', async () => {
      await writeFile(join(dir, 'a.txt'), 'hello\n');
      const r = await fileEditTool.execute(
        { path: 'a.txt', oldString: '', newString: 'x' },
        ctx(dir),
      );
      expect(r.error).toBe(
        'oldString must not be empty. Use file_write to create or overwrite a file.',
      );
    });

    it('reports a missing file', async () => {
      const r = await fileEditTool.execute(
        { path: 'missing.txt', oldString: 'a', newString: 'b' },
        ctx(dir),
      );
      expect(r.error).toBe('File not found: missing.txt');
    });

    it('reports a directory', async () => {
      await mkdir(join(dir, 'd'), { recursive: true });
      const r = await fileEditTool.execute({ path: 'd', oldString: 'a', newString: 'b' }, ctx(dir));
      expect(r.error).toBe('Path is a directory: d');
    });

    it('preserves indentation around the replacement', async () => {
      await writeFile(join(dir, 'ind.txt'), '  if (x) {\n    y();\n  }\n');
      const r = await fileEditTool.execute(
        { path: 'ind.txt', oldString: '    y();', newString: '    z();' },
        ctx(dir),
      );
      expect(r.status).toBe('success');
      expect(await readFile(join(dir, 'ind.txt'), 'utf8')).toBe('  if (x) {\n    z();\n  }\n');
    });

    it('matches CRLF only when oldString contains CRLF', async () => {
      await writeFile(join(dir, 'crlf.txt'), 'a\r\nb\r\n');
      const ok = await fileEditTool.execute(
        { path: 'crlf.txt', oldString: 'a\r\nb', newString: 'A\r\nB' },
        ctx(dir),
      );
      expect(ok.status).toBe('success');
      const bad = await fileEditTool.execute(
        { path: 'crlf.txt', oldString: 'A\nB', newString: 'x' },
        ctx(dir),
      );
      expect(bad.status).toBe('error');
    });

    it('rejects binary files', async () => {
      await writeFile(join(dir, 'bin.txt'), 'abc\u0000def');
      const r = await fileEditTool.execute(
        { path: 'bin.txt', oldString: 'abc', newString: 'x' },
        ctx(dir),
      );
      expect(r.error).toBe('Cannot edit binary file: bin.txt');
    });
  });
});
