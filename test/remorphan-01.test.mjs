import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recoverOrphan, hasOrphanOwner } from '../src/ama/orphan-watchdog.mjs';

function setup(t, pr = 7707) {
  const rootDir = mkdtempSync(join(tmpdir(), 'remorphan-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const fixture = JSON.parse(readFileSync(new URL(`./fixtures/remorphan/${pr}.json`, import.meta.url)));
  const calls = { dispatch: [], pages: [], reviews: [] };
  const args = { ...fixture, rootDir, repo: 'example/repo', headSha: 'current-head',
    candidate: { prState: 'open', headSha: 'current-head' }, reviewStateRow: { review_status: 'posted' },
    hasOwnerImpl: async () => false,
    closerHeadImpl: async () => ({ suppressed: true, reason: 'closer-commit-trailer' }),
    dispatchHammer: async evidence => { calls.dispatch.push(evidence); return { dispatched: true }; },
    pageImpl: async (...page) => calls.pages.push(page),
    requestRereviewImpl: async request => { calls.reviews.push(request); return { triggered: true }; } };
  return { args, calls, tick: overrides => recoverOrphan({ ...args, ...overrides }) };
}
for (const pr of [7707, 7716, 7704]) test(`#${pr} replay waits six observations and launches one HAM`, async t => {
  const { tick, calls } = setup(t, pr);
  for (let i = 0; i < 5; i++) { await tick(); assert.equal(calls.dispatch.length, 0); }
  assert.equal((await tick()).outcome, 'ama-dispatched');
  assert.equal(calls.dispatch.length, 1);
  assert.equal(calls.dispatch[0].primaryRepair, pr === 7716);
  assert.equal(calls.dispatch[0].closerHead, pr === 7704);
  await tick({ hasOwnerImpl: async () => true });
  assert.equal(calls.dispatch.length, 1);
});
for (const owner of ['remediator', 'closer', 'merge-agent', 'reviewer']) test(`live ${owner} resets consecutive ticks`, async t => {
  const { tick, calls } = setup(t);
  for (let i = 0; i < 5; i++) await tick();
  await tick({ hasOwnerImpl: async () => true });
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(calls.dispatch.length, 0);
});
for (const label of ['do-not-merge', 'no-merge-hold', 'merge-agent-skip']) test(`${label} forbids dispatch`, async t => {
  const { tick, calls } = setup(t);
  for (let i = 0; i < 8; i++) await tick({ labels: [label] });
  assert.equal(calls.dispatch.length, 0);
});
test('two failed attempts exhaust durably and page once with evidence', async t => {
  const { tick, calls } = setup(t);
  const failure = { dispatchHammer: async () => { calls.dispatch.push('failed'); return { dispatched: false, reason: 'failed' }; } };
  for (let i = 0; i < 25; i++) await tick(failure);
  assert.equal(calls.dispatch.length, 2);
  assert.equal(calls.pages.length, 1);
  assert.equal(calls.pages[0][1].payload.attempts, 2);
  assert.equal(calls.pages[0][1].payload.lastAttempt.reason, 'failed');
});
test('uncertifiable closer head requests one exact-head review', async t => {
  const { tick, calls } = setup(t, 7704);
  for (let i = 0; i < 20; i++) await tick({ dispatchHammer: async () => ({ dispatched: false, reason: 'cannot-recertify' }) });
  assert.equal(calls.reviews.length, 1);
  assert.equal(calls.reviews[0].targetRevisionRef, 'current-head');
});
test('external stale head cannot enter orphan HAM route', async t => {
  const { tick, calls } = setup(t, 7704);
  for (let i = 0; i < 8; i++) await tick({ closerHeadImpl: async () => ({ suppressed: false }) });
  assert.equal(calls.dispatch.length, 0);
});
for (const override of [{ candidate: { prState: 'closed' } }, { candidate: { prState: 'merged' } },
  { candidate: { prState: 'open', isDraft: true } }, { result: { amaEnabled: true, reasons: ['security-hold'] } }]) {
  test(`terminal/draft/safety state: ${JSON.stringify(override)}`, async t => {
    const { tick, calls } = setup(t);
    for (let i = 0; i < 8; i++) await tick(override);
    assert.equal(calls.dispatch.length, 0);
  });
}
test('cross-head closer and merge-agent ledger probes fail closed', async t => {
  const { args } = setup(t);
  for (const bucket of ['ama-closer-dispatches', 'merge-agent-dispatches']) {
    const dir = join(args.rootDir, 'data', 'follow-up-jobs', bucket);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'launch.json'), JSON.stringify({ repo: args.repo, prNumber: args.prNumber,
      headSha: 'older-head', launchRequestId: 'lrq-live' }));
    assert.equal(await hasOrphanOwner({ ...args, readStatusImpl: async () => ({ ok: true, row: { status: 'running' } }) }), true);
    assert.equal(await hasOrphanOwner({ ...args, readStatusImpl: async () => ({ ok: false }) }), true);
    rmSync(dir, { recursive: true });
  }
});
test('pending remediation job and reviewer queue retain ownership', async t => {
  const { args } = setup(t);
  assert.equal(await hasOrphanOwner({ ...args, reviewStateRow: { review_status: 'reviewing' } }), true);
  const dir = join(args.rootDir, 'data', 'follow-up-jobs', 'pending');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'job.json'), JSON.stringify({ repo: args.repo, prNumber: args.prNumber }));
  assert.equal(await hasOrphanOwner(args), true);
});
test('concurrent observers serialize dispatch and restart preserves attempt budget', async t => {
  const { tick, calls } = setup(t);
  for (let i = 0; i < 5; i++) await tick();
  await Promise.all([tick(), tick(), tick()]);
  assert.equal(calls.dispatch.length, 1);
});

test('watcher coexistence invokes orphan recovery on sixth tick', async t => {
  const { resolveMergeAgentCoexistenceForWatcher } = await import('../src/ama-closure-orchestration.mjs');
  for (const pr of [7707, 7716, 7704]) {
    const { args, calls } = setup(t, pr);
    const input = { rootDir: args.rootDir, repoPath: args.repo, prNumber: pr,
      candidate: args.candidate, currentRevisionRef: args.headSha,
      reviewStateRow: args.reviewStateRow, dispatchJob: args.dispatchJob,
      maybeDispatchAmaClosureForImpl: async options => {
        if (options.orphanRecovery) { calls.dispatch.push(options.orphanRecovery); return { dispatched: true }; }
        return args.result;
      },
      orphanOptions: { hasOwnerImpl: args.hasOwnerImpl, closerHeadImpl: args.closerHeadImpl,
        pageImpl: args.pageImpl, requestRereviewImpl: args.requestRereviewImpl },
      logger: { info() {}, warn() {} } };
    for (let i = 0; i < 5; i++) await resolveMergeAgentCoexistenceForWatcher(input);
    assert.equal(calls.dispatch.length, 0);
    assert.equal((await resolveMergeAgentCoexistenceForWatcher(input)).outcome, 'ama-dispatched');
    assert.equal(calls.dispatch.length, 1);
  }
});
test('head change resets tick streak and never refunds a previous head budget', async t => {
  const { tick, calls } = setup(t);
  const fail = { dispatchHammer: async () => { calls.dispatch.push('failed'); return { dispatched: false }; } };
  for (let i = 0; i < 12; i++) await tick(fail);
  await tick({ ...fail, headSha: 'new-head', candidate: { prState: 'open', headSha: 'new-head' } });
  await tick(fail);
  assert.equal(calls.dispatch.length, 2);
  assert.equal(calls.pages.length, 1);
});
test('exhaustion still pages when ordinary HAM retry cap takes over', async t => {
  const { tick, calls } = setup(t);
  for (let i = 0; i < 12; i++) await tick({ dispatchHammer: async () => ({ dispatched: false }) });
  await tick({ result: { amaEnabled: true, reason: 'dispatch-retry-exhausted' } });
  assert.equal(calls.pages.length, 1);
});
test('page enqueue failure retries delivery without another HAM', async t => {
  const { tick, calls } = setup(t);
  for (let i = 0; i < 12; i++) await tick({ dispatchHammer: async () => { calls.dispatch.push('failed'); return { dispatched: false }; } });
  await assert.rejects(tick({ pageImpl: async () => { throw new Error('outbox unavailable'); } }), /outbox unavailable/);
  await tick();
  await tick();
  assert.equal(calls.pages.length, 1);
  assert.equal(calls.dispatch.length, 2);
});
test('raced live-owner refusal refunds reserved attempt', async t => {
  const { tick, calls } = setup(t);
  for (let i = 0; i < 18; i++) await tick({ dispatchHammer: async () => ({ dispatched: false, reason: 'active-remediation-job' }) });
  assert.equal(calls.pages.length, 0);
  for (let i = 0; i < 6; i++) await tick();
  assert.equal(calls.dispatch.length, 1);
});
test('terminal merge-agent ledger defeats stale dispatched label', async t => {
  const { args } = setup(t);
  const dir = join(args.rootDir, 'data', 'follow-up-jobs', 'merge-agent-dispatches');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'launch.json'), JSON.stringify({ repo: args.repo, prNumber: args.prNumber, launchRequestId: 'terminal-lrq' }));
  assert.equal(await hasOrphanOwner({ ...args, labels: ['merge-agent-dispatched'],
    readStatusImpl: async () => ({ ok: true, row: { status: 'failed' } }) }), false);
});
