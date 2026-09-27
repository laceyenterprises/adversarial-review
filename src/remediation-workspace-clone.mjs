import { existsSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { loadDomainConfig } from './domain-config.mjs';

function isRemoteBranchNotFoundError(err) {
  const detail = [err?.message, err?.stdout, err?.stderr].filter(Boolean).join('\n');
  return /\bremote branch\b[^\n]*\bnot found\b/i.test(detail)
    || /\bnot found in upstream origin\b/i.test(detail);
}

// Domain config is local to this repository, so a per-repo path can be set
// without adding a key to the shared agent-os config.yaml schemas.
export async function cloneRemediationWorkspace({
  rootDir, repo, domainId = 'code-pr', baseBranch, workspaceDir, clone, resetWorkspaceDir, log = console,
}) {
  const configured = loadDomainConfig(rootDir, domainId || 'code-pr')?.remediationCloneReferences?.[repo];
  const referenceRelativeToWorkspace = typeof configured === 'string'
    ? relative(workspaceDir, configured) : '';
  const referenceInsideWorkspace = referenceRelativeToWorkspace === '' ||
    (!referenceRelativeToWorkspace.startsWith('..') && !isAbsolute(referenceRelativeToWorkspace));
  const referenceHasObjects = typeof configured === 'string'
    && (existsSync(join(configured, 'objects')) || existsSync(join(configured, '.git', 'objects')));
  const reference = typeof configured === 'string' && isAbsolute(configured)
    && !referenceInsideWorkspace
    && referenceHasObjects
    ? configured : null;
  if (typeof configured === 'string' && !reference) {
    let reason = 'missing-objects';
    if (!isAbsolute(configured)) {
      reason = 'relative-path';
    } else if (referenceInsideWorkspace) {
      reason = 'inside-workspace';
    }
    log.warn?.(`[follow-up-remediation] clone reference ignored repo=${repo} reason=${reason} path=${configured}`);
  }
  const branchArgs = branch => (branch ? ['--single-branch', '--branch', String(branch)] : []);
  const networkArgs = branch => [
    'clone',
    '--no-checkout',
    ...branchArgs(branch),
    `https://github.com/${repo}.git`,
    workspaceDir,
  ];
  const cloneWithoutBranchNarrowing = async () => {
    resetWorkspaceDir(workspaceDir);
    log.warn?.(`[follow-up-remediation] base branch ${baseBranch} not found for repo=${repo}; retrying clone without --single-branch`);
    await clone(networkArgs(null));
    return 'network';
  };
  if (reference) {
    try {
      await clone(['clone', '--reference', reference, '--dissociate', ...networkArgs(baseBranch).slice(1)]);
      return 'reference';
    } catch (err) {
      log.warn?.(`[follow-up-remediation] reference clone failed repo=${repo}; falling back to network clone: ${err.message}`);
      if (baseBranch && isRemoteBranchNotFoundError(err)) {
        return cloneWithoutBranchNarrowing();
      }
      resetWorkspaceDir(workspaceDir);
    }
  }
  try {
    await clone(networkArgs(baseBranch));
    return 'network';
  } catch (err) {
    if (baseBranch && isRemoteBranchNotFoundError(err)) {
      return cloneWithoutBranchNarrowing();
    }
    throw err;
  }
}
