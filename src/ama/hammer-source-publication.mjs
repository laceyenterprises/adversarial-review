import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { assertCustodyRedriveTarget, CUSTODY_REDRIVE_FILE, readCustodyRedriveIntent } from './custody-redrive.mjs';
import { conflictPublishBinding } from './hammer-conflict-binding.mjs';
import { hammerGhCall, hammerLocalGit, hammerNetworkCall } from './hammer-api-network.mjs';
import { hammerTokenSession } from '../hammer-token.mjs';
import { proveRebaseResult } from './rebase-result.mjs';

const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const git = (...args) => hammerLocalGit(['--no-replace-objects', ...args]).toString().trim();
const refusal = (reason, phaseOutcome = 'source-publication-refused') => Object.assign(new Error(reason), { phaseOutcome });
export const movedPublicationHead = reason => refusal(reason, 'head-changed');
export const isCustodyPublication = () => Boolean(process.env.HAM_RUN_DIR
  && existsSync(join(process.env.HAM_RUN_DIR, CUSTODY_REDRIVE_FILE)));

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
  const custody = isCustodyPublication();
  if (custody) assertCustodyRedriveTarget(live, repo);
  const { ref: branch, sha: previousHead } = live.head ?? {};
  if (!sha(previousHead) || typeof branch !== 'string' || !branch) throw refusal('PR source branch or head unavailable');
  git('check-ref-format', `refs/heads/${branch}`);
  return { branch, previousHead, baseRef: live.base?.ref, ...(custody ? { custody } : {}) };
}

export async function inspectHammerSource({ branch, previousHead, baseRef, localHead, custody }) {
  if (!sha(localHead) || git('rev-parse', '--verify', 'HEAD^{commit}') !== localHead || git('status', '--porcelain')) {
    throw refusal('local publication head is unavailable, changed or dirty');
  }
  const expectedRebase = process.env.HAM_CLOSE_REBASE_HEAD;
  if (expectedRebase && localHead !== expectedRebase) {
    throw movedPublicationHead('conflict repair head changed before publication');
  }
  if (!custody && localHead === previousHead) return 'unchanged';
  const conflict = conflictPublishBinding(process.env.HAM_RUN_DIR, () => localHead);
  if (expectedRebase && !conflict) throw refusal('conflict repair publication binding unavailable');
  if (conflict && (conflict.branch !== branch || conflict.source !== previousHead)) {
    throw movedPublicationHead('PR head or branch moved after conflict repair captured its source');
  }
  if (custody) {
    const pending = readCustodyRedriveIntent(process.env);
    if (!conflict?.base || pending.source.redrive.candidate !== localHead) throw refusal('validated custody candidate unavailable');
  }
  if (localHead === previousHead) return 'unchanged';
  await hammerNetworkCall('git', ['fetch', '--no-recurse-submodules', 'origin', previousHead]);
  if (git('rev-parse', '--is-shallow-repository') !== 'false') throw refusal('publication ancestry is incomplete');
  if (isAncestor(localHead, previousHead)) {
    throw movedPublicationHead('PR head descends from the local candidate; preserve the remote commits');
  }
  if (custody) {
    if (isAncestor(previousHead, localHead)) return 'fast-forward';
    if (!isAncestor(conflict.base, localHead)) throw refusal('custody rewrite does not include its validated base');
    const base = `refs/heads/${baseRef}`;
    git('check-ref-format', base);
    const current = (await hammerNetworkCall('git', ['ls-remote', '--exit-code', 'origin', base])).toString().trim();
    if (current !== `${conflict.base}\t${base}`) throw movedPublicationHead('PR base moved after custody validation');
    return 'rewrite';
  }
  if (conflict) return 'rewrite';
  if (isAncestor(previousHead, localHead)) return 'fast-forward';
  if (!sha(process.env.HAM_BASE_HEAD)) {
    throw refusal('captured publication source unavailable');
  }
  if (previousHead !== process.env.HAM_BASE_HEAD) {
    throw movedPublicationHead('divergent PR head differs from the captured publication source');
  }
  if (typeof baseRef === 'string' && baseRef) {
    const base = `refs/heads/${baseRef}`;
    git('check-ref-format', base);
    // REST base.sha may predate later main commits. Bind replay to the base
    // branch we actually fetched, without trusting a mutable tracking ref.
    await hammerNetworkCall('git', ['fetch', '--no-tags', '--no-recurse-submodules', 'origin', base]);
    const baseHead = git('rev-parse', '--verify', 'FETCH_HEAD^{commit}');
    const replayBase = git('merge-base', baseHead, localHead);
    if (await proveRebaseResult({ oldHead: previousHead, head: localHead, base: replayBase, git: args => git(...args) })) {
      return 'rewrite';
    }
  }
  throw refusal('local rewrite lacks source-bound rebase proof');
}
