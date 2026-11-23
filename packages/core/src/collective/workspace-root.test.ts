import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveParticipantWorkspaceRoot, workspaceRootError } from './workspace-root.js';

describe('resolveParticipantWorkspaceRoot', () => {
  const launch = '/launch';

  it('uses an absolute participant root as-is', () => {
    expect(resolveParticipantWorkspaceRoot({ workspaceRoot: '/srv/a' }, undefined, launch)).toBe(
      '/srv/a',
    );
  });

  it('resolves a relative participant root against the collective root', () => {
    expect(
      resolveParticipantWorkspaceRoot({ workspaceRoot: 'projects/a' }, undefined, launch),
    ).toBe('/launch/projects/a');
  });

  it('falls back to the config default when the participant has no root', () => {
    expect(
      resolveParticipantWorkspaceRoot(undefined, { workspaceRoot: '/srv/default' }, launch),
    ).toBe('/srv/default');
  });

  it('resolves a relative config default against the collective root', () => {
    expect(resolveParticipantWorkspaceRoot(undefined, { workspaceRoot: 'shared' }, launch)).toBe(
      '/launch/shared',
    );
  });

  it('prefers the participant root over the config default', () => {
    expect(
      resolveParticipantWorkspaceRoot(
        { workspaceRoot: 'projects/a' },
        { workspaceRoot: 'shared' },
        launch,
      ),
    ).toBe('/launch/projects/a');
  });

  it('treats an empty participant root as absent and uses the config default', () => {
    expect(
      resolveParticipantWorkspaceRoot({ workspaceRoot: '' }, { workspaceRoot: 'shared' }, launch),
    ).toBe('/launch/shared');
  });

  it('treats an empty participant root with no config as the collective root', () => {
    expect(resolveParticipantWorkspaceRoot({ workspaceRoot: '' }, undefined, launch)).toBe(launch);
  });

  it('falls back to the collective root', () => {
    expect(resolveParticipantWorkspaceRoot(undefined, undefined, launch)).toBe(launch);
  });
});

describe('workspaceRootError', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'legion-root-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('accepts an existing directory', async () => {
    await mkdir(join(root, 'project'));
    await expect(workspaceRootError(join(root, 'project'), root)).resolves.toBeNull();
  });

  it('accepts a relative directory under the collective root', async () => {
    await mkdir(join(root, 'project'));
    await expect(workspaceRootError('project', root)).resolves.toBeNull();
  });

  it('rejects a missing path', async () => {
    await expect(workspaceRootError('missing', root)).resolves.toBe(
      'workspaceRoot does not exist: missing',
    );
  });

  it('rejects a file', async () => {
    await writeFile(join(root, 'file.txt'), 'x');
    await expect(workspaceRootError('file.txt', root)).resolves.toBe(
      'workspaceRoot is not a directory: file.txt',
    );
  });
});
