import { existsSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { loadDomainConfig } from './domain-config.mjs';

// Domain config is local to this repository, so a per-repo path can be set
// without adding a key to the shared agent-os config.yaml schemas.
export async function cloneRemediationWorkspace({
  rootDir, repo, domainId = 'code-pr', baseBranch, workspaceDir, clone, resetWorkspaceDir, log,
}) {
  const configured = loadDomainConfig(rootDir, domainId || 'code-pr')?.remediationCloneReferences?.[repo];
  const referenceRelativeToWorkspace = typeof configured === 'string'
    ? relative(workspaceDir, configured) : '';
  const referenceInsideWorkspace = referenceRelativeToWorkspace === '' ||
    (!referenceRelativeToWorkspace.startsWith('..') && !isAbsolute(referenceRelativeToWorkspace));
  const reference = typeof configured === 'string' && isAbsolute(configured)
    && !referenceInsideWorkspace
    && (existsSync(join(configured, 'objects')) || existsSync(join(configured, '.git', 'objects')))
    ? configured : null;
  const branchArgs = baseBranch ? ['--single-branch', '--branch', String(baseBranch)] : [];
  const networkArgs = ['clone', '--no-checkout', ...branchArgs, `https://github.com/${repo}.git`, workspaceDir];
  if (reference) {
    try {
      await clone(['clone', '--reference', reference, '--dissociate', ...networkArgs.slice(1)]);
      return 'reference';
    } catch (err) {
      log.warn?.(`[follow-up-remediation] reference clone failed repo=${repo}; falling back to network clone: ${err.message}`);
      resetWorkspaceDir(workspaceDir);
    }
  }
  await clone(networkArgs);
  return 'network';
}
