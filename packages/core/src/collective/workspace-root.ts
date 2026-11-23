import { stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { BaseParticipant, WorkspaceConfig } from '@legion-collective/types';

/**
 * Resolve the effective workspace root for a participant.
 *
 * Precedence: participant root > WorkspaceConfig.workspaceRoot > collective
 * (launch) root. Absolute values are used as-is; relative values resolve
 * against the collective root.
 */
export function resolveParticipantWorkspaceRoot(
  participant: Pick<BaseParticipant, 'workspaceRoot'> | undefined,
  config: Pick<WorkspaceConfig, 'workspaceRoot'> | undefined,
  collectiveWorkspaceRoot: string,
): string {
  const configured = participant?.workspaceRoot ?? config?.workspaceRoot;
  if (!configured) return collectiveWorkspaceRoot;
  return isAbsolute(configured)
    ? resolve(configured)
    : resolve(collectiveWorkspaceRoot, configured);
}

/**
 * Validate a user-supplied participant root. Returns an error message when the
 * resolved path is missing or is not a directory; `null` means valid.
 */
export async function workspaceRootError(
  value: string,
  collectiveWorkspaceRoot: string,
): Promise<string | null> {
  const resolved = resolve(collectiveWorkspaceRoot, value);
  try {
    const info = await stat(resolved);
    return info.isDirectory() ? null : `workspaceRoot is not a directory: ${value}`;
  } catch {
    return `workspaceRoot does not exist: ${value}`;
  }
}
