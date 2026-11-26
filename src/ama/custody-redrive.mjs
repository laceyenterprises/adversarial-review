import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isOperatorHeld } from '../operator-hold-labels.mjs';
import { deferredSourceRedrive, readDeferredSourceHold } from './deferred-source-custody.mjs';
import { hammerLocalGit } from './hammer-api-network.mjs';

const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const localGit = args => hammerLocalGit(['--no-replace-objects', ...args]);
export const CUSTODY_REDRIVE_FILE = 'custody-redrive.json';
export class CustodyReplayRefusal extends Error {}

export function readCustodyRedriveIntent(env) {
  const { targetHead, attempt, count } = JSON.parse(readFileSync(join(env.HAM_RUN_DIR, CUSTODY_REDRIVE_FILE), 'utf8'));
  const pending = deferredSourceRedrive(readDeferredSourceHold(env.HAM_HQ_ROOT, {
    repo: env.HAM_REPO, prNumber: env.HAM_PR_NUMBER, headSha: targetHead,
  }));
  if (!pending || pending.hold.attempt !== attempt || pending.source.redrive?.count !== count
    || targetHead !== env.HAM_TARGET_REMEDIATION_SHA || pending.source.redrive.headSha !== targetHead
    || pending.source.redrive.refusal) {
    throw new Error('custody retry no longer owns the retained attempt');
  }
  return pending;
}

export function assertCustodyRedriveTarget(live, repo) {
  if (live.state !== 'open' || live.merged !== false || live.draft !== false || !Array.isArray(live.labels)
    || isOperatorHeld(live.labels) || live.labels.some(label => ['adversarial-merge-blocked', 'duplicate-family-hold'].includes(label?.name))
    || live.head?.repo?.full_name?.toLowerCase() !== repo.toLowerCase()
    || live.base?.repo?.full_name?.toLowerCase() !== repo.toLowerCase()) {
    throw new Error('custody retry target is terminal, held, draft or outside the provisioned repository');
  }
}

// Restore the retained commit only on its original PR head. A clean merge
// with current base is enough for a fast-forward publication. A retained
// rewrite (e.g. prior conflict repair) must already include the current base.
export async function restoreCustodySource(pending, { liveHead, baseHead, fetchObject, git = localGit }) {
  const { hold, source } = pending;
  const out = (...args) => git(args).toString().trim();
  const exists = head => {
    try { out('cat-file', '-e', `${head}^{commit}`); return true; }
    catch (error) { if (!error.status || error.signal) throw error; return false; }
  };
  if (![liveHead, baseHead, hold.targetHead, hold.sourceHead].every(sha)
    || out('rev-parse', '--verify', 'HEAD^{commit}') !== liveHead || out('status', '--porcelain')) {
    throw new Error('custody retry requires the clean, pinned PR checkout');
  }
  if (liveHead !== hold.targetHead) throw new CustodyReplayRefusal('retained-target-moved');
  const prerequisites = source.prerequisites ?? [];
  if (!Array.isArray(prerequisites) || prerequisites.length > 2 || !prerequisites.every(sha)) {
    throw new CustodyReplayRefusal('invalid-bundle-prerequisites');
  }
  for (const head of new Set([hold.targetHead, ...prerequisites])) {
    if (!exists(head)) await fetchObject(head);
  }
  const bundle = join(hold.evidenceDir, 'source.bundle');
  if (out('bundle', 'list-heads', bundle, source.ref) !== `${hold.sourceHead} ${source.ref}`) {
    throw new CustodyReplayRefusal('retained-bundle-head-mismatch');
  }
  out('bundle', 'verify', bundle);
  out('fetch', '--no-tags', '--no-recurse-submodules', bundle, source.ref);
  if (out('rev-parse', '--verify', 'FETCH_HEAD^{commit}') !== hold.sourceHead) throw new Error('retained commit mismatch');
  if (out('rev-parse', '--is-shallow-repository') !== 'false') throw new Error('custody replay requires complete ancestry');
  const succeeds = (...args) => {
    try { out(...args); return true; }
    catch (error) {
      if (error.status === 1 && !error.signal && !error.killed) return false;
      throw error;
    }
  };
  if (hold.sourceHead === baseHead || succeeds('merge-base', '--is-ancestor', hold.sourceHead, liveHead)) {
    throw new CustodyReplayRefusal('retained-source-has-no-unpublished-change');
  }
  const fastForward = succeeds('merge-base', '--is-ancestor', liveHead, hold.sourceHead);
  const includesBase = succeeds('merge-base', '--is-ancestor', baseHead, hold.sourceHead);
  if (!fastForward && !includesBase) throw new CustodyReplayRefusal('retained-rewrite-base-moved');
  if (!includesBase && !succeeds('merge-tree', '--write-tree', '--quiet', baseHead, hold.sourceHead)) {
    throw new CustodyReplayRefusal('retained-source-conflicts-with-base');
  }
  out('-c', 'core.hooksPath=/dev/null', 'switch', '--detach', hold.sourceHead);
  const head = out('rev-parse', '--verify', 'HEAD^{commit}');
  if (head !== hold.sourceHead || out('status', '--porcelain')) throw new Error('custody replay did not produce a clean PR candidate');
  return head;
}
