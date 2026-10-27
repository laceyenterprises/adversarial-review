import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { acquireMergeLease, acquireDaemonMergeLease, releaseMergeLease, readMergeLeaseWaiters, inspectMergeLease } from '../../src/ama/merge-lease.mjs';
import { evaluateMergeEligibility } from '../../src/ama/merge-eligibility.mjs';

// Disposable Git + real lease queue, driven by an explicit deterministic schedule.
// No timers, live credentials, daemon state or provider calls are involved.
export function exerciseValidatedCloserQueue(rootDir, { strict = false, samePath = false } = {}) {
  mkdirSync(rootDir, { recursive: true });
  const cwd = join(rootDir, 'checkout'); mkdirSync(cwd);
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ALLOW_PROTOCOL: 'file',
    GIT_AUTHOR_NAME: 'Fixture', GIT_COMMITTER_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const git = (...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', timeout: 5000 }).trim();
  const remote = join(rootDir, 'remote.git');
  git('init', '--bare', '-q', remote); git('init', '-q', '-b', 'main'); git('remote', 'add', 'origin', remote);
  const commit = message => { git('add', '--', 'a', 'b', 'unrelated'); git('commit', '-qm', message); return git('rev-parse', 'HEAD'); };
  const shared = Array.from({ length: 80 }, (_, i) => `line ${i}\n`);
  for (const file of ['a', 'b', 'unrelated']) writeFileSync(join(cwd, file), samePath && file === 'a' ? shared.join('') : 'base\n');
  const base = commit('base'); git('push', '-q', 'origin', 'main');
  const heads = [];
  for (const [pr, file] of [[1, 'a'], [2, 'b']]) {
    git('checkout', '-q', '-B', `pr-${pr}`, base);
    const target = samePath ? 'a' : file;
    const contents = [...shared];
    contents[pr * 20] = `author intent ${pr}\n`;
    writeFileSync(join(cwd, target), samePath ? contents.join('') : 'author intent\n'); commit('author');
    contents[pr * 20 + 1] = `HAM finding fixed ${pr}\n`;
    writeFileSync(join(cwd, target), samePath ? contents.join('') : 'author intent\nHAM finding fixed\n'); heads.push(commit('HAM remediation'));
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
  const epoch = Date.UTC(2026, 0, 1);
  let milliseconds = 0;
  const now = () => new Date(epoch + milliseconds++).toISOString();
  const request = pr => ({ ...identity, holderPr: pr, holderHead: heads[pr - 1] || base, waiterId: `closer-${pr}`, now: now() });
  const acquire = pr => acquireMergeLease(request(pr));
  const release = (lease, outcome = { merged: true }) => {
    const result = releaseMergeLease({ rootDir, ...lease, ...outcome,
      now: now(), requestWatcherWakeImpl: () => {} });
    assert.equal(result.released, true);
    return result;
  };
  const advance = text => {
    if (samePath) {
      const lines = readFileSync(join(cwd, 'a'), 'utf8').split('\n'); lines[65] = text.trim();
      writeFileSync(join(cwd, 'a'), lines.join('\n'));
    }
    writeFileSync(join(cwd, 'unrelated'), text); commit('base advance'); git('push', '-q', 'origin', 'main');
  };
  const blocker = acquire(99); assert.equal(blocker.acquired, true);
  assert.equal(acquire(1).acquired, false); assert.equal(acquire(2).acquired, false);
  advance('advance before queued validation\n'); release(blocker.lease);
  // Both validated heads wait for CI without holding the lease. An immediate
  // re-registration is still in backoff, so the other ready closer can proceed.
  // Once eligible, the original FIFO arrivals survive both no-merge releases.
  const first = acquire(1); assert.equal(first.acquired, true);
  const firstWait = release(first.lease, { yielded: true, reason: 'required-checks-wait' });
  const firstRetry = acquire(1); assert.equal(firstRetry.acquired, false);
  assert.equal(firstRetry.waiter.arrivedAt, first.waiter.arrivedAt);
  const second = acquire(2); assert.equal(second.acquired, true);
  const secondWait = release(second.lease, { yielded: true, reason: 'required-checks-wait' });
  const secondRetry = acquire(2); assert.equal(secondRetry.acquired, false);
  assert.equal(secondRetry.waiter.arrivedAt, second.waiter.arrivedAt);
  // Advance the explicit clock to both actual policy deadlines. No real sleep
  // or assumption about the host's load-scaled backoff is needed.
  milliseconds = Math.max(milliseconds, Date.parse(firstWait.retry.nextEligibleAt) - epoch,
    Date.parse(secondWait.retry.nextEligibleAt) - epoch);
  const merged = [];
  let sourceMutations = 0, ciRestarts = 0;
  for (const pr of [1, 2]) {
    const granted = acquire(pr); assert.equal(granted.acquired, true);
    let head = heads[pr - 1];
    const previouslyValidated = head;
    assert.equal(needsRebase(head, '1'), true, 'strict protection still requires containment');
    assert.equal(needsRebase(head, ''), true, 'unknown protection fails closed');
    assert.equal(needsRebase(head, '0'), samePath, 'path overlap still requires rebase even for disjoint hunks');
    assert.equal(needsRebase(head, '0', 'CONFLICTING'), true, 'live conflicts require rebase even with disjoint path lists');
    assert.equal(needsRebase(head, '0', 'MERGEABLE', true), true, 'comparison errors cannot authorize disjoint retention');
    if (strict || samePath) {
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
    if (strict || samePath) assert.equal(gate([{ name: 'required', conclusion: 'SUCCESS' }], previouslyValidated).eligible, false,
      'old exact-head green evidence cannot authorize the rebase');
    assert.equal(gate([{ name: 'required', status: 'IN_PROGRESS' }]).eligible, false);
    assert.equal(gate([{ name: 'required', conclusion: 'SUCCESS' }]).eligible, true);
    assert.equal(git('rev-parse', `pr-${pr}`), head, 'published source ref matches the exact head selected for closure');
    git('merge', '--squash', head); commit(`merge PR ${pr}`); git('push', '-q', 'origin', 'main');
    merged.push(pr); release(granted.lease);
    if (pr === 1) {
      const daemon = acquireDaemonMergeLease({ ...request(99), waiterId: 'daemon-advance' });
      assert.equal(daemon.acquired, false, 'later daemon cannot overtake the earlier second closer');
      assert.equal(daemon.queuePosition, 2);
      // An external main update can still occur between cooperating closers.
      advance('advance between queued closes\n');
    }
  }
  const daemon = acquireDaemonMergeLease({ ...request(99), waiterId: 'daemon-advance' });
  assert.equal(daemon.acquired, true, 'daemon proceeds after both earlier closers');
  release(daemon.lease);
  assert.equal(readMergeLeaseWaiters(rootDir, identity).length, 0);
  assert.equal(inspectMergeLease(identity).lease, null);
  if (samePath) {
    for (const pr of [1, 2]) {
      const text = readFileSync(join(cwd, 'a'), 'utf8');
      assert.ok(text.includes(`author intent ${pr}\nHAM finding fixed ${pr}\n`));
    }
  } else for (const file of ['a', 'b']) assert.equal(readFileSync(join(cwd, file), 'utf8'), 'author intent\nHAM finding fixed\n');
  // A rename must include its source path in the PR file set. Main changed
  // that path even though it never touched the rename destination.
  git('checkout', '-q', '--detach', base); git('mv', 'a', 'renamed'); git('commit', '-qm', 'rename');
  assert.equal(needsRebase(git('rev-parse', 'HEAD'), '0'), true, 'renamed-away paths still overlap');
  git('checkout', '-q', 'main');
  assert.equal(sourceMutations, strict || samePath ? 2 : 0);
  return { merged, sourceMutations, ciRestarts, leaseAndWaitersClean: true };
}
