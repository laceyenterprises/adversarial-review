// Kept inside the launch's src-only scope; run with node --test explicitly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, openSync, closeSync, readFileSync, readdirSync, symlinkSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import fsExt from 'fs-ext';
// The standard runner discovers test/ only. Enter the same symlink-preserving
// isolation before importing production modules, which can open module-local state.
if (!process.env.ADVERSARIAL_REVIEW_TEST_SANDBOX_ROOT) {
  const repo = fileURLToPath(new URL('../', import.meta.url));
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'batch-tests-')));
  const worker = join(sandbox, 'file-0');
  mkdirSync(worker);
  try {
    for (const entry of readdirSync(repo, { withFileTypes: true })) {
      if (entry.name === 'data' || entry.name === '.git') continue;
      symlinkSync(join(repo, entry.name), join(worker, entry.name), entry.isDirectory() ? 'dir' : 'file');
    }
    const bin = join(sandbox, 'bin');
    mkdirSync(bin);
    for (const command of ['gh', 'hq', 'codex']) writeFileSync(join(bin, command), '#!/bin/sh\nexit 78\n', { mode: 0o755 });
    const env = { PATH: `${bin}:${process.env.PATH}`, TMPDIR: sandbox,
      NODE_OPTIONS: '--preserve-symlinks --preserve-symlinks-main',
      ADVERSARIAL_REVIEW_TEST_SANDBOX_ROOT: sandbox, ADVERSARIAL_REVIEW_TEST_REEXEC: '1',
      GIT_CEILING_DIRECTORIES: sandbox, AGENT_OS_DEPLOY_CHECKOUT: join(sandbox, 'deploy') };
    const result = spawnSync(process.execPath, ['--preserve-symlinks', '--preserve-symlinks-main', '--test',
      join(worker, 'src/findings-batch-regressions.test.mjs')], { cwd: worker, env, stdio: 'inherit' });
    process.exitCode = result.status ?? 1;
  } finally { rmSync(sandbox, { recursive: true, force: true }); }
  process.exit(process.exitCode);
}
await import('../test/helpers/load-aware-timeout-fixture.mjs');
const { __testables__: closer } = await import('./ama/dispatch-closer.mjs');
const { acquireAmaCloserLease, updateAmaCloserLease, releaseRetryableAmaCloserLease } = await import('./ama/closer-lease.mjs');
const { launchRequestMeaning } = await import('./ama/launch-request-status.mjs');
const { recoverOrphan } = await import('./ama/orphan-watchdog.mjs');
const { inspectLegacyPoolOverrides } = await import('./config-token-pool-migration.mjs');
const { conflictOwnerReviewRoute } = await import('./conflict-owner-review-route.mjs');
const { ensureReviewStateSchema } = await import('./review-state.mjs');
const { readReviewObservations } = await import('./review-observations.mjs');
const { recoverOverdueOwnership } = await import('./ownerproof-review-recovery.mjs');
const { dispatchReadTransport } = await import('./dispatch-read-client.mjs');
const { listHardeningRecordsFromSdk } = await import('./hardening-ledger-context.mjs');
const { readDispatchStdout, readDispatchStdoutSync, MAX_DISPATCH_STDOUT_BYTES } = await import('./dispatch-files-client.mjs');
const { readPinnedCopyWarnings } = await import('./agy-reviewer-identities.mjs');
const { resolveRemediationModel } = await import('./adapters/agent-runtime/local/remediation.mjs');
const { closureOwnerShadowEvidence } = await import('./pr-next-action-consumer.mjs');
const { deriveNextActionSnapshot, nextAction } = await import('./pr-next-action.mjs');
const { registerSharedNextAction, resolveSharedNextAction, shadowNextAction } = await import('./pr-next-action-shadow.mjs');

const HEAD = 'a'.repeat(40), OLD = 'b'.repeat(40);
const quiet = { log() {}, info() {}, warn() {}, error() {} };
const identity = { repo: 'example/repo', prNumber: 1, headSha: HEAD };
function directory(t) {
  const root = mkdtempSync(join(tmpdir(), 'batch-regression-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function store(t) {
  const rootDir = directory(t);
  mkdirSync(join(rootDir, 'data'));
  const db = new Database(join(rootDir, 'data/reviews.db'));
  t.after(() => db.close());
  ensureReviewStateSchema(db);
  return { rootDir, db };
}

test('closer capture resolves explicit, environment and daemon-default hq binaries', async () => {
  for (const [hqPath, env, expected] of [
    ['/explicit/hq', { HQ_BIN: '/environment/hq' }, '/explicit/hq'],
    [undefined, { HQ_BIN: '/environment/hq' }, '/environment/hq'],
    [undefined, { PATH: '/usr/bin:/bin' }, '/Users/airlock/.local/bin/hq'],
  ]) {
    let binary;
    assert.equal(await closer.emitWorkerGitMergeSignalBestEffort({
      hqPath: closer.resolveCloserHqPath({ hqPath }, env), env,
      hqRoot: '/synthetic/hq', ...identity, mergeCommitSha: HEAD,
      mode: 'squash', logger: quiet,
      execFileImpl: async command => { binary = command; return { stdout: JSON.stringify({ status: 'recorded', event_id: 'synthetic-event' }) }; },
    }), true);
    assert.equal(binary, expected);
  }
});

test('invalid local capture selectors remain distinct from producer outages', async () => {
  for (const reason of ['missing-repo', 'missing-pr-number', 'missing-signal-kind']) {
    const result = await closer.readMergedBuildCompletionSignalAsync({
      ...identity, logger: { warn: () => assert.fail('local validation is not an outage') },
      readBuildCompletionSignalForPrImpl: async () => ({ ok: false, reason }),
    });
    assert.deepEqual(result, { ok: false, reason });
  }
});

test('capture diagnostics write transitions once and clear on authoritative recovery', () => {
  const first = closer.mergeCaptureDiagnosticUpdate({ id: 1 }, { readReason: 'unavailable' }, 'first');
  assert.equal(first.mergeCaptureReadAt, 'first');
  assert.equal(closer.mergeCaptureDiagnosticUpdate(first, { readReason: 'unavailable' }, 'later'), null);
  assert.equal(closer.mergeCaptureDiagnosticUpdate(first, { readReason: 'denied' }, 'later').mergeCaptureReadAt, 'later');
  for (const signal of [{ ok: true }, { ok: false, reason: 'missing-build-completion-signal' },
    { ok: false, reason: 'missing-build-completion-producer-evidence' }]) {
    assert.deepEqual(closer.mergeCaptureDiagnosticUpdate(first, signal, 'later'), { id: 1 });
  }
  assert.equal(closer.mergeCaptureDiagnosticUpdate(first, { ok: false, reason: 'missing-repo' }, 'later'), null);
  assert.equal(first.mergeCaptureReadAt, 'first', 'updates must not mutate observed records');
});

test('hardening context requests only its leading bounded page', async t => {
  let calls = 0;
  t.mock.method(dispatchReadTransport, 'lookup', async selector => {
    calls++;
    assert.equal(selector.limit, 8);
    assert.equal(selector.offset, 0);
    return { schema_version: 1, observation: 'hardening_records', status: 'found',
      items: Array.from({ length: 8 }, (_, i) => ({ record_id: String(i) })),
      complete: false, next_offset: 8, scope_complete: false, mutation_authority: false };
  });
  assert.equal((await listHardeningRecordsFromSdk('synthetic.contract')).length, 8);
  assert.equal(calls, 1, 'context must not page through records it discards');
});

test('case-variant rows cannot hide a current reviewing owner', t => {
  const { rootDir, db } = store(t);
  const insert = db.prepare(`INSERT INTO reviewed_prs(repo,pr_number,review_status,reviewer_head_sha,reviewed_at,reviewer)
    VALUES (?,1,?,?,'2026-10-01T00:00:00Z','fixture')`);
  insert.run('example/repo', 'posted', HEAD);
  insert.run('Example/Repo', 'reviewing', HEAD);
  assert.equal(conflictOwnerReviewRoute({ rootDir, ...identity }).route, 'review-in-flight');
  db.prepare("UPDATE reviewed_prs SET reviewer_head_sha=NULL WHERE review_status='reviewing'").run();
  assert.equal(conflictOwnerReviewRoute({ rootDir, ...identity }).route, 'review-in-flight');
  db.prepare("UPDATE reviewed_prs SET reviewer_head_sha=? WHERE review_status='reviewing'").run(OLD);
  assert.equal(conflictOwnerReviewRoute({ rootDir, ...identity }).route, 'hammer');
});

test('multiple accounts of a provider preserve legacy account-order agreement', () => {
  for (const [members, expected] of [
    [['corp1', 'corp2'], true], [['corp1', 'corp2', 'personal'], true],
    [['corp1', 'personal', 'corp2'], false], [['missing'], false],
  ]) {
    const values = { 'oauth.identity_token_pools': { hammer: members },
      'oauth.token_accounts': { corp1: { broker_provider: 'codex-corp' }, corp2: { broker_provider: 'codex-corp' },
        personal: { broker_provider: 'codex' } }, 'roles.codex_worker_account_order': 'corporate-first' };
    const result = inspectLegacyPoolOverrides({ get: (key, fallback) => values[key] ?? fallback,
      resolutionTrace: () => [{ source: 'fixture' }] });
    assert.equal(result.conflicts.length === 0, expected);
  }
});

test('discovery recovery normalizes fresh candidate labels', async () => {
  let labels;
  const selected = { head: HEAD, row: 'R08-retry', action: 'hammer', actor: 'hammer',
    queue: { intent: 'dispatch' }, deadline: { at: '2026-10-27T10:00:00Z' } };
  const result = await recoverOverdueOwnership({
    rootDir: '/synthetic', ...identity, enabled: true, subject: { headSha: HEAD },
    now: '2026-10-27T10:30:00Z',
    readLaneImpl: () => ({ headSha: HEAD, nextAction: selected }),
    recoverImpl: async input => { await input.dispatchHammer({}); return { outcome: 'ama-pending' }; },
    fetchCandidateImpl: async () => ({ headSha: HEAD, prState: 'OPEN', labels: [{ name: 'one' }, 'two'] }),
    dispatchImpl: async input => { labels = input.labelNames; return { dispatched: true }; },
  });
  assert.deepEqual(labels, ['one', 'two']);
  assert.equal(result.outcome, 'ama-pending');
});

for (const outcome of ['ama-pending', 'recovery-exhausted']) {
  test(`real discovery consumes ${outcome} recovery without claiming another reviewer`, t => {
    const root = directory(t);
    const hook = join(root, 'recovery-hook.mjs');
    writeFileSync(hook, `
      import { registerHooks } from 'node:module';
      import { readFileSync } from 'node:fs';
      registerHooks({ load(url, context, nextLoad) {
        const result = nextLoad(url, context);
        if (!url.endsWith('/test/watcher-claim-loop.test.mjs')) return result;
        return { ...result, source: readFileSync(new URL(url), 'utf8').replaceAll(
          "return { outcome: 'ama-dispatched' };", ${JSON.stringify(`return { outcome: '${outcome}' };`)}) };
      } });
    `);
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--preserve-symlinks', '--preserve-symlinks-main',
      '--import', hook, '--test', '--test-name-pattern=OWNERDEADLINE-01: every open subject',
      'test/watcher-claim-loop.test.mjs'], { env, encoding: 'utf8', timeout: 60000 });
    assert.equal(result.status, 0, `${result.stdout || ''}${result.stderr || ''}`);
    assert.match(result.stdout, /every open subject visits deadline recovery/);
  });
}

test('a new ownership generation does not inherit its predecessor expired deadline', async t => {
  const rootDir = directory(t);
  let pages = 0;
  const result = { amaEnabled: true, nextAction: { head: HEAD, row: 'R08-retry', action: 'hammer',
    actor: 'hammer', queue: { intent: 'dispatch' }, deadline: { at: '2026-10-27T10:00:00Z' } } };
  const recovered = await recoverOrphan({
    rootDir, ...identity, candidate: { headSha: HEAD, prState: 'OPEN' }, result,
    now: '2026-10-27T10:30:00Z', env: { OWNERPROOF_IDLE_MINUTES: '15' }, logger: quiet,
    hasOwnerImpl: async () => ({ owned: false }),
    onOwnershipObserved: () => { result.nextAction = { head: HEAD, row: 'R04-ownership',
      action: 'snapshot-refresh', actor: 'watcher', queue: { intent: 'reconcile' },
      deadline: { at: '2026-10-27T11:00:00Z' } }; },
    pageImpl: async () => { pages++; return { queued: true }; },
    dispatchHammer: () => assert.fail('fresh reconciliation cannot dispatch'),
  });
  assert.equal(recovered.outcome, 'ama-pending');
  assert.equal(pages, 0);
  assert.equal(recovered.amaClosureResult.ownerlessIdleMs, 0);
});

test('retryable audit settlement tolerates a real contended lease mutation', t => {
  const rootDir = directory(t);
  const acquired = acquireAmaCloserLease({ rootDir, ...identity, watcherPid: process.pid });
  updateAmaCloserLease({ rootDir, ...identity, status: 'dispatched', lrqId: 'synthetic-launch' });
  const fd = openSync(`${acquired.leasePath}.reclaim.lock`, 'a');
  try {
    fsExt.flockSync(fd, 'exnb');
    assert.equal(releaseRetryableAmaCloserLease({ rootDir, ...identity, launchRequestId: 'synthetic-launch',
      attempt: { outcome: 'deferred', reason: 'required-checks-pending' }, logger: quiet }), false);
    assert.equal(JSON.parse(readFileSync(acquired.leasePath)).status, 'dispatched');
  } finally { fsExt.flockSync(fd, 'un'); closeSync(fd); }
  assert.equal(releaseRetryableAmaCloserLease({ rootDir, ...identity, launchRequestId: 'synthetic-launch',
    attempt: { outcome: 'deferred', reason: 'required-checks-pending' }, logger: quiet }), true);
});

test('native pinned-copy observations coalesce and expire without changing explicit pool refreshes', async t => {
  let now = 1_000, calls = 0;
  t.mock.method(Date, 'now', () => now);
  const env = { AGENT_OS_DEPLOY_CHECKOUT: '/synthetic/deploy' };
  const runImpl = async () => { calls++; return { code: 0, stdout: '[]' }; };
  await Promise.all([readPinnedCopyWarnings({ env, runImpl }), readPinnedCopyWarnings({ env, runImpl })]);
  assert.equal(calls, 1);
  now += 30_001;
  await readPinnedCopyWarnings({ env, runImpl });
  assert.equal(calls, 2);
  env.AGENT_OS_DEPLOY_CHECKOUT = '/synthetic/other';
  await readPinnedCopyWarnings({ env, runImpl });
  assert.equal(calls, 3);
});

test('closeout lookup is deterministic across repo casing and uses case-insensitive indexes', t => {
  const { rootDir, db } = store(t);
  db.prepare(`INSERT INTO reviewed_prs(repo,pr_number,review_status,reviewed_at,reviewer)
    VALUES ('example/repo',1,'posted','2026-10-01T00:00:00Z','fixture')`).run();
  const insert = db.prepare('INSERT INTO pr_merge_closeouts(repo,pr_number,closeout_body_md,closeout_posted_at) VALUES (?,1,?,?)');
  insert.run('example/repo', 'old body', '2026-10-01T00:00:00Z');
  insert.run('Example/Repo', 'new body', '2026-10-02T00:00:00Z');
  const read = () => readReviewObservations({ rootDir, selector: { kind: 'reviews' }, repositories: ['example/repo'] });
  assert.equal(read().items[0].closeout_body, 'new body');
  for (const table of ['reviewer_passes', 'pr_merge_closeouts']) {
    const detail = db.prepare(`EXPLAIN QUERY PLAN SELECT * FROM ${table} WHERE repo=? COLLATE NOCASE AND pr_number=?`)
      .all('example/repo', 1).map(row => row.detail).join(' ');
    assert.match(detail, /SEARCH/);
    assert.match(detail, /_observation/);
  }
});

test('CLI distinguishes invalid input, grant and payload faults without exposing internals', () => {
  for (const [input, expected] of [
    ['{', 'invalid review request JSON'],
    [JSON.stringify({ selector: { kind: 'invalid' }, repositories: ['example/repo'] }), 'invalid review selector'],
    [JSON.stringify({ selector: { kind: 'reviews' }, repositories: [] }), 'review repository grant required'],
    [' '.repeat(32769), 'request too large'],
  ]) {
    const result = spawnSync(process.execPath, ['src/review-observations-cli.mjs'], { input, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.trim(), expected);
  }
});

test('invalid incident pins have a distinct operator-visible configuration failure', t => {
  t.mock.method(dispatchReadTransport, 'hostServicesSync', () => { throw new Error('unavailable'); });
  assert.throws(() => resolveRemediationModel('remediator-codex', {
    env: {}, pin: 'not-an-allowed-model', log: quiet,
  }), error => error.failureClass === 'reviewer-configuration-error'
    && error.reason === 'invalid-model-pin' && error.category === 'configuration'
    && error.code === 'registry-unavailable' && error.modelSource === 'unresolved');
});

test('suspended launch meanings retain boolean succeeded and explicit wire overrides', () => {
  assert.equal(launchRequestMeaning('suspended').succeeded, false);
  assert.equal(launchRequestMeaning('suspended').terminal, false);
  assert.equal(launchRequestMeaning({ status: 'suspended', succeeded: true }).succeeded, true);
});

function placeholder(t, headless = false) {
  const rootDir = directory(t);
  const evidence = closureOwnerShadowEvidence({ currentHead: HEAD,
    lease: { status: 'terminal', terminalOutcome: 'failed-without-merge', lrqId: 'synthetic-closer', headSha: HEAD },
    launchRecord: { launchRequestId: 'synthetic-closer', terminalOutcome: 'failed-without-merge' },
    reviewState: { verdict: 'comment-only', headSha: OLD, blockingFindingState: 'known', blockingFindingCount: 0,
      nonBlockingFindingState: 'known', nonBlockingFindingCount: 0 },
    checks: 'SUCCESS', roundsLeft: false,
    closerAuthoredStale: { decision: 'carry-forward', carryForward: true, reviewedHead: OLD, currentHead: HEAD },
  }, { rootDir, subjectKey: 'example/repo#1', observedAt: '2026-01-01T04:00:00Z',
    anchors: { firstActionableAt: '2026-01-01T00:00:00Z' }, autonomousMergeExecutionEnabled: true,
    candidate: { headSha: HEAD, prState: 'OPEN', mergeable: 'MERGEABLE' } });
  let snapshot = deriveNextActionSnapshot({ ...evidence, observations: { ...evidence.observations, controls: {} } });
  if (headless) {
    const launches = structuredClone(snapshot.observations.launches);
    delete launches.value.closer.headSha;
    snapshot = deriveNextActionSnapshot({ base: snapshot, observations: { launches } });
  }
  return { rootDir, snapshot };
}
const launchWire = () => ({ schema_version: 1, status: 'found', complete: true,
  roots: ['synthetic-closer'], items: [{ launch_request_id: 'synthetic-closer', status: 'succeeded' }], retry_edges: [] });

test('headless launch placeholders reuse the resolved per-pass observation', async t => {
  const f = placeholder(t, true);
  let reads = 0;
  t.mock.method(dispatchReadTransport, 'lookup', async () => { reads++; return launchWire(); });
  assert.equal((await resolveSharedNextAction(f)).decision.row, 'R08-retry');
  assert.equal((await resolveSharedNextAction(f)).decision.row, 'R08-retry');
  assert.equal(reads, 1);
});

test('shadow placeholder resolution cannot publish a replacement routing generation', async t => {
  const f = placeholder(t);
  const pair = { snapshot: f.snapshot, decision: nextAction(f.snapshot) };
  registerSharedNextAction(f.snapshot, pair);
  const before = await resolveSharedNextAction({ passSnapshot: f.snapshot });
  t.mock.method(dispatchReadTransport, 'lookup', async () => launchWire());
  const shadow = await shadowNextAction({ ...f, sink: () => {}, now: () => Date.parse('2026-01-01T04:00:00Z') });
  assert.equal(shadow.decision.row, 'R08-retry');
  const after = await resolveSharedNextAction({ passSnapshot: f.snapshot });
  assert.equal(after, before);
  assert.equal(after.decision.row, 'R04-ownership');
});

function filePage(offset, nextOffset, size, text, extra = {}) {
  return { ok: true, log: { status: 'found', redacted: true, text, offset, nextOffset, size,
    complete: nextOffset === size, truncated: nextOffset !== size, reset: false,
    generation: 'one', boundaryTruncated: false, ...extra } };
}
test('stdout fallback pages beyond 256 KiB using raw offsets, in sync and async readers', async t => {
  const text = 'x'.repeat(262144);
  const pages = [filePage(0, 262144, 300000, text), filePage(262144, 300000, 300000, '[redacted]終')];
  const offsets = [];
  const read = selector => { offsets.push(selector.offset); return pages[offsets.length - 1]; };
  const sync = readDispatchStdoutSync({ launch_request_id: 'launch' }, {}, read);
  assert.equal(sync.log.text, text + '[redacted]終');
  assert.deepEqual(offsets, [0, 262144]);
  let call = 0;
  t.mock.method(dispatchReadTransport, 'lookup', async selector => {
    const page = pages[call++];
    assert.equal(selector.offset, page.log.offset);
    return { schema_version: 1, status: 'found', launchRequestId: 'launch', runId: 'run',
      metadata: { status: 'found', launchRequestId: 'launch', runId: 'run' }, log: page.log,
      scope_complete: false, mutation_authority: false };
  });
  const asyncResult = await readDispatchStdout({ launch_request_id: 'launch' });
  assert.equal(asyncResult.ok, true);
  assert.equal(asyncResult.log.text, sync.log.text);
  assert.equal(call, 2);
});
for (const [name, first, second] of [
  ['generation change', filePage(0, 1, 2, 'a'), filePage(1, 2, 2, 'b', { generation: 'two' })],
  ['file growth', filePage(0, 1, 2, 'a'), filePage(1, 3, 3, 'bc')],
  ['boundary truncation', filePage(0, 1, 1, 'a', { boundaryTruncated: true })],
  ['reset', filePage(0, 1, 1, 'a', { reset: true })],
  ['oversize', filePage(0, 1, MAX_DISPATCH_STDOUT_BYTES + 1, 'a')],
  ['nonadvancing page', filePage(0, 0, 2, '')],
]) {
  test(`stdout fallback retains failure on ${name}`, () => {
    let calls = 0;
    assert.equal(readDispatchStdoutSync({ launch_request_id: 'launch' }, {},
      () => [first, second][calls++]).ok, false);
  });
}
