import { existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { inspectWorkspaceState, preserveInvalidResumeWorkspace } from './remediation-git-pr-io.mjs';

// Reject workspace symlinks and preserve unsafe metadata before Git touches it.
export async function preserveUnsafeWorkspaceMetadata({
  workspaceDir, workspaceRootDir, jobId, repo, execFileImpl, log,
}) {
  // Check the workspace itself before any Git command can touch its target.
  if (lstatSync(workspaceDir, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error(`Cannot safely prepare symlinked remediation workspace: ${workspaceDir}`);
  }
  // Preserve redirected metadata without running Git against the shared gitdir.
  // A standalone clone with leftover registrations additionally needs the
  // expected remote before we can move it aside without stranding foreign work.
  const existingGitDir = join(workspaceDir, '.git');
  const existingGitMetadata = lstatSync(existingGitDir, { throwIfNoEntry: false });
  let preservedMetadataReason = null;
  if (existingGitMetadata) {
    if (!existingGitMetadata.isDirectory() || existsSync(join(existingGitDir, 'commondir'))) {
      preservedMetadataReason = 'redirected-git-metadata';
    } else if (existsSync(join(existingGitDir, 'worktrees'))) {
      const state = await inspectWorkspaceState({ workspaceDir, expectedRepo: repo, allowDirty: true, execFileImpl });
      if (state.actualRepo !== repo) {
        const refusal = `Cannot safely preserve remediation workspace with worktree registrations: ${workspaceDir}; expected repo=${repo}, actual repo=${state.actualRepo || 'unknown'}`;
        log.error?.(`[follow-up-remediation] ${refusal}`);
        throw new Error(refusal);
      }
      preservedMetadataReason = 'leftover-worktree-registrations';
    }
    if (preservedMetadataReason) {
      preserveInvalidResumeWorkspace({ workspaceDir, workspaceRootDir, jobId,
        reason: preservedMetadataReason, log });
    }
  }
  return preservedMetadataReason;
}
