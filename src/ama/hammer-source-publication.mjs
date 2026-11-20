import { conflictPublishBinding } from './hammer-conflict-binding.mjs';
import { hammerGhCall, hammerLocalGit, hammerNetworkCall } from './hammer-api-network.mjs';
import { hammerTokenSession } from '../hammer-token.mjs';
import { proveRebaseResult } from './rebase-result.mjs';

const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const git = (...args) => hammerLocalGit(['--no-replace-objects', ...args]).toString().trim();
const refusal = (reason, phaseOutcome = 'source-publication-refused') => Object.assign(new Error(reason), { phaseOutcome });
export const movedPublicationHead = reason => refusal(reason, 'head-changed');

function isAncestor(ancestor, head) {
  try { git('merge-base', '--is-ancestor', ancestor, head); return true; }
  catch (error) {
    if (error.status !== 1 || error.signal || error.killed) throw error;
    return false;
  }
}

export async function readHammerSource(repo, prNumber) {
  if (!hammerTokenSession({ hammerToken: true }).managed) throw refusal('hammer publication credential unavailable');
  const live = JSON.parse(await hammerGhCall(['api', `repos/${repo}/pulls/${prNumber}`]));
  const { ref: branch, sha: previousHead } = live.head ?? {};
  if (!sha(previousHead) || typeof branch !== 'string' || !branch) throw refusal('PR source branch or head unavailable');
  git('check-ref-format', `refs/heads/${branch}`);
  return { branch, previousHead, base: live.base?.sha };
}

export async function inspectHammerSource({ branch, previousHead, base, localHead }) {
  if (!sha(localHead) || git('rev-parse', '--verify', 'HEAD^{commit}') !== localHead || git('status', '--porcelain')) {
    throw refusal('local publication head is unavailable, changed or dirty');
  }
  if (localHead === previousHead) return 'unchanged';
  const conflict = conflictPublishBinding(process.env.HAM_RUN_DIR, () => localHead);
  if (conflict && (conflict.branch !== branch || conflict.source !== previousHead)) {
    throw movedPublicationHead('PR head or branch moved after conflict repair captured its source');
  }
  await hammerNetworkCall('git', ['fetch', '--no-recurse-submodules', 'origin', previousHead]);
  if (git('rev-parse', '--is-shallow-repository') !== 'false') throw refusal('publication ancestry is incomplete');
  if (isAncestor(localHead, previousHead)) {
    throw movedPublicationHead('PR head descends from the local candidate; preserve the remote commits');
  }
  if (isAncestor(previousHead, localHead)) return 'fast-forward';
  if (conflict) return 'rewrite';
  if (!sha(process.env.HAM_BASE_HEAD)) {
    throw refusal('captured publication source unavailable');
  }
  if (previousHead !== process.env.HAM_BASE_HEAD) {
    throw movedPublicationHead('divergent PR head differs from the captured publication source');
  }
  if (sha(base)) {
    await hammerNetworkCall('git', ['fetch', '--no-recurse-submodules', 'origin', base]);
    const replayBase = git('merge-base', base, localHead);
    if (await proveRebaseResult({ oldHead: previousHead, head: localHead, base: replayBase, git: args => git(...args) })) {
      return 'rewrite';
    }
  }
  throw refusal('local rewrite lacks source-bound rebase proof');
}
