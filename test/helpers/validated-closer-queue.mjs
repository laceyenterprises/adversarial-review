import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { acquireMergeLease, acquireDaemonMergeLease, releaseMergeLease, readMergeLeaseWaiters, inspectMergeLease } from '../../src/ama/merge-lease.mjs';
import { evaluateMergeEligibility } from '../../src/ama/merge-eligibility.mjs';

// Disposable Git + real lease queue, driven by an explicit deterministic schedule.
// No timers, live credentials, daemon state or provider calls are involved.
export function exerciseValidatedCloserQueue(rootDir, { strict = false } = {}) {
  mkdirSync(rootDir, { recursive: true });
  const cwd = join(rootDir, 'checkout'); mkdirSync(cwd);
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ALLOW_PROTOCOL: 'file',
    GIT_AUTHOR_NAME: 'Fixture', GIT_COMMITTER_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const git = (...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', timeout: 5000 }).trim();
  const remote = join(rootDir, 'remote.git');
  git('init', '--bare', '-q', remote); git('init', '-q', '-b', 'main'); git('remote', 'add', 'origin', remote);
  const commit = message => { git('add', '--', 'a', 'b', 'unrelated'); git('commit', '-qm', message); return git('rev-parse', 'HEAD'); };
  for (const file of ['a', 'b', 'unrelated']) writeFileSync(join(cwd, file), 'base\n');
  const base = commit('base'); git('push', '-q', 'origin', 'main');
  const heads = [];
  for (const [pr, file] of [[1, 'a'], [2, 'b']]) {
    git('checkout', '-q', '-B', `pr-${pr}`, base);
    writeFileSync(join(cwd, file), 'author intent\n'); commit('author');
    writeFileSync(join(cwd, file), 'author intent\nHAM finding fixed\n'); heads.push(commit('HAM remediation'));
  }
  git('checkout', '-q', 'main');
  const source = readFileSync(new URL('../../bin/hammer-verify-head.sh', import.meta.url), 'utf8');
  const policy = source.slice(source.indexOf('ham_base_touches_pr_files() {'), source.indexOf('# Shared by initial verification'));
  assert.ok(policy.startsWith('ham_base_touches_pr_files() {') && policy.trimEnd().endsWith('}'));
  const needsRebase = (head, strict, mergeable = 'MERGEABLE', failComparison = false) => {
    const result = spawnSync('/bin/bash', ['-c', `
ham_is_full_sha() { [[ "$1" =~ ^[a-f0-9]{40}$ ]]; }
ham_bounded_git_sync() { git fetch -q origin "$@"; }
${policy}
if [ "$4" = true ]; then comm() { return 2; }; fi
BASE_BRANCH=main
POST_REMEDIATION_SHA="$1"
HAM_REQUIRES_UP_TO_DATE="$2"
ham_base_touches_pr_files validated-head "$3"
`, 'fixture', head, strict, mergeable, String(failComparison)], { cwd, env, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.signal, null, result.stderr);
    assert.ok([0, 1].includes(result.status), result.stderr);
    return result.status === 0;
  };
  const identity = { rootDir, repo: 'fixture/queue', base: 'main', holderPid: process.pid, holderHost: hostname(), registerWaiter: true };
  let seconds = 0;
  const now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds++)).toISOString();
  const request = pr => ({ ...identity, holderPr: pr, holderHead: heads[pr - 1] || base, waiterId: `closer-${pr}`, now: now() });
  const acquire = pr => acquireMergeLease(request(pr));
  const release = lease => assert.equal(releaseMergeLease({ rootDir, ...lease, now: now(), requestWatcherWakeImpl: () => {} }).released, true);
  const advance = text => { writeFileSync(join(cwd, 'unrelated'), text); commit('unrelated base advance'); git('push', '-q', 'origin', 'main'); };
  const blocker = acquire(99); assert.equal(blocker.acquired, true);
  assert.equal(acquire(1).acquired, false); assert.equal(acquire(2).acquired, false);
  advance('advance before queued validation\n'); release(blocker.lease);
  // Both already-validated heads take their first lease-free CI wait, then
  // rejoin FIFO. Neither can overtake the other's existing reservation.
  const first = acquire(1); assert.equal(first.acquired, true); release(first.lease);
  assert.equal(acquire(1).acquired, false);
  const second = acquire(2); assert.equal(second.acquired, true); release(second.lease);
  assert.equal(acquire(2).acquired, false);
  const merged = [];
  let sourceMutations = 0, ciRestarts = 0;
  for (const pr of [1, 2]) {
    const granted = acquire(pr); assert.equal(granted.acquired, true);
    let head = heads[pr - 1];
    const previouslyValidated = head;
    assert.equal(needsRebase(head, '1'), true, 'strict protection still requires containment');
    assert.equal(needsRebase(head, ''), true, 'unknown protection fails closed');
    assert.equal(needsRebase(head, '0'), false, 'unrelated advancement keeps the exact validated head');
    assert.equal(needsRebase(head, '0', 'CONFLICTING'), true, 'live conflicts require rebase even with disjoint path lists');
    assert.equal(needsRebase(head, '0', 'MERGEABLE', true), true, 'comparison errors cannot authorize disjoint retention');
    if (strict) {
      git('checkout', '-q', `pr-${pr}`); git('rebase', 'main');
      head = git('rev-parse', 'HEAD'); heads[pr - 1] = head;
      git('checkout', '-q', 'main');
      assert.notEqual(head, previouslyValidated);
      assert.equal(needsRebase(head, '1'), false, 'strict head contains current base after one required rebase');
      sourceMutations++; ciRestarts++;
    }
    const gate = (checks, validatedHead = head) => evaluateMergeEligibility({ verdict: 'settled-success', leaseHeld: true, requiredChecks: checks,
      branchProtectionRequired: false, requiresUpToDateBranch: strict, mergeable: 'MERGEABLE', mergeStateStatus: strict ? 'CLEAN' : 'BEHIND',
      prState: 'OPEN', labels: [], candidateHead: head, validatedHead });
    if (strict) assert.equal(gate([{ name: 'required', conclusion: 'SUCCESS' }], previouslyValidated).eligible, false,
      'old exact-head green evidence cannot authorize the rebase');
    assert.equal(gate([{ name: 'required', status: 'IN_PROGRESS' }]).eligible, false);
    assert.equal(gate([{ name: 'required', conclusion: 'SUCCESS' }]).eligible, true);
    assert.equal(git('rev-parse', `pr-${pr}`), head, 'published source ref matches the exact head selected for closure');
    git('merge', '--squash', head); commit(`merge PR ${pr}`); git('push', '-q', 'origin', 'main');
    merged.push(pr); release(granted.lease);
    if (pr === 1) {
      const daemon = acquireDaemonMergeLease({ ...request(99), waiterId: 'daemon-advance' });
      assert.equal(daemon.acquired, true, 'daemon priority remains ahead of the second closer');
      advance('advance between queued closes\n'); release(daemon.lease);
    }
  }
  assert.equal(readMergeLeaseWaiters(rootDir, identity).length, 0);
  assert.equal(inspectMergeLease(identity).lease, null);
  for (const file of ['a', 'b']) assert.equal(readFileSync(join(cwd, file), 'utf8'), 'author intent\nHAM finding fixed\n');
  // A rename must include its source path in the PR file set. Main changed
  // that path even though it never touched the rename destination.
  git('checkout', '-q', '--detach', base); git('mv', 'a', 'renamed'); git('commit', '-qm', 'rename');
  assert.equal(needsRebase(git('rev-parse', 'HEAD'), '0'), true, 'renamed-away paths still overlap');
  git('checkout', '-q', 'main');
  assert.equal(sourceMutations, strict ? 2 : 0);
  return { merged, sourceMutations, ciRestarts, leaseAndWaitersClean: true };
}
