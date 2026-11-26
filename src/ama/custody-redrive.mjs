import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isOperatorHeld } from '../operator-hold-labels.mjs';
import { deferredSourceRedrive, readDeferredSourceHold } from './deferred-source-custody.mjs';
import { hammerLocalGit } from './hammer-api-network.mjs';

const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const localGit = args => hammerLocalGit(['--no-replace-objects', ...args]);
export const CUSTODY_REDRIVE_FILE = 'custody-redrive.json';

export function readCustodyRedriveIntent(env) {
  const { targetHead, attempt, count } = JSON.parse(readFileSync(join(env.HAM_RUN_DIR, CUSTODY_REDRIVE_FILE), 'utf8'));
  const pending = deferredSourceRedrive(readDeferredSourceHold(env.HAM_HQ_ROOT, {
    repo: env.HAM_REPO, prNumber: env.HAM_PR_NUMBER, headSha: targetHead,
  }));
  if (!pending || pending.hold.attempt !== attempt || pending.source.redrive?.count !== count
    || pending.source.redrive.headSha !== env.HAM_TARGET_REMEDIATION_SHA) {
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

// Restore the exact bundle, then replay only the unpublished range over a
// descendant PR head. Rebase the resulting PR commits onto the current base.
// Diverged histories and conflicts require a human to disambiguate changes.
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
  const prerequisites = source.prerequisites ?? [];
  if (!Array.isArray(prerequisites) || prerequisites.length > 2 || !prerequisites.every(sha)) {
    throw new Error('custody bundle prerequisites are invalid');
  }
  for (const head of new Set([hold.targetHead, ...prerequisites])) {
    if (!exists(head)) await fetchObject(head);
  }
  const bundle = join(hold.evidenceDir, 'source.bundle');
  if (out('bundle', 'list-heads', bundle, source.ref) !== `${hold.sourceHead} ${source.ref}`) {
    throw new Error('custody bundle does not advertise the retained commit');
  }
  out('bundle', 'verify', bundle);
  out('fetch', '--no-tags', '--no-recurse-submodules', bundle, source.ref);
  if (out('rev-parse', '--verify', 'FETCH_HEAD^{commit}') !== hold.sourceHead) throw new Error('retained commit mismatch');
  if (out('rev-parse', '--is-shallow-repository') !== 'false') throw new Error('custody replay requires complete ancestry');
  const rebase = (base, upstream) => {
    try { out('-c', 'core.hooksPath=/dev/null', '-c', 'rerere.enabled=false',
      'rebase', '--no-autostash', '--no-update-refs', '--rebase-merges', '--onto', base, upstream); }
    catch (error) {
      try { out('rebase', '--abort'); } catch { /* Keep the original refusal. */ }
      throw error;
    }
  };
  out('-c', 'core.hooksPath=/dev/null', 'switch', '--detach', hold.sourceHead);
  if (liveHead !== hold.targetHead) {
    out('merge-base', '--is-ancestor', hold.targetHead, liveHead);
    out('merge-base', '--is-ancestor', hold.targetHead, hold.sourceHead);
    rebase(liveHead, hold.targetHead);
  }
  const fork = out('merge-base', baseHead, 'HEAD');
  if (fork !== baseHead) rebase(baseHead, fork);
  const head = out('rev-parse', '--verify', 'HEAD^{commit}');
  if (head === baseHead || out('status', '--porcelain')) throw new Error('custody replay did not produce a clean PR candidate');
  return head;
}
