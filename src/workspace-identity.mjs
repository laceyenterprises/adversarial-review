import { existsSync, lstatSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { inspectWorkspaceState, preserveInvalidResumeWorkspace } from './remediation-git-pr-io.mjs';

// Preserve workspace symlinks and unsafe metadata before Git touches them.
export async function preserveUnsafeWorkspaceMetadata({
  workspaceDir, workspaceRootDir, jobId, repo, execFileImpl, log,
}) {
  // Check the workspace itself before any Git command can touch its target.
  if (lstatSync(workspaceDir, { throwIfNoEntry: false })?.isSymbolicLink()) {
    const backupDir = join(workspaceRootDir, `${jobId}.resume-backup-${Date.now()}-${process.pid}`);
    renameSync(workspaceDir, backupDir);
    log.warn?.(`[follow-up-remediation] preserved workspace symlink at ${backupDir}; preparing a fresh checkout`);
    return 'workspace-symlink';
  }
  // Preserve redirected metadata without running Git against the shared gitdir.
  // For a standalone clone with leftover registrations, refuse a positively
  // foreign remote; preserve unknown daemon-owned metadata.
  const existingGitDir = join(workspaceDir, '.git');
  const existingGitMetadata = lstatSync(existingGitDir, { throwIfNoEntry: false });
  let preservedMetadataReason = null;
  if (existingGitMetadata) {
    if (!existingGitMetadata.isDirectory() || existsSync(join(existingGitDir, 'commondir'))) {
      preservedMetadataReason = 'redirected-git-metadata';
    } else if (existsSync(join(existingGitDir, 'worktrees'))) {
      const state = await inspectWorkspaceState({ workspaceDir, expectedRepo: repo, allowDirty: true, execFileImpl });
      if (state.actualRepo && state.actualRepo !== repo) {
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
