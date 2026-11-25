// REPAIRDISPATCHREAD-01: the in-place repair reservation must prepare the
// dispatch read context before it reads closer-launch ownership. All fixtures
// are synthetic; the SDK transport is mocked, so nothing leaves the process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { withoutConfigSchemaDiagnostics } from './helpers/config-schema-diagnostic.mjs';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { main as repairMain } from '../bin/repair-in-place.mjs';
import { dispatchReadTransport } from '../src/dispatch-read-client.mjs';
import { openReviewStateDb, ensureReviewStateSchema } from '../src/review-state.mjs';
import { amaCloserLeaseFilePath } from '../src/ama/closer-lease.mjs';
import { hammerRetryCapFilePath, mutateRepairEpochs, readHammerRetryCapLedger } from '../src/ama/hammer-retry-cap.mjs';
import { bindRepairHead, pageRepairCap, pendingRepairEpoch, reconcileRepairOwner, reserveRepairEpoch,
  REPAIR_ABSENCE_ESCALATE_MS, REPAIR_OWNER_OBSERVE_MS } from '../src/repair-epochs.mjs';
import { observeClosureWait } from '../src/ama/closure-wait.mjs';
import { recordPrRound, PR_ROUND_KINDS } from '../src/pr-round-ledger.mjs';
import { pairedDispatchAbsence } from './helpers/repair-dispatch-scope.mjs';

const repo = 'example/widgets', prNumber = 23, head = 'd'.repeat(40);
const closerLaunch = 'lrq_synthetic_closer';
// Keep all recovery fixtures offline while exercising the production boundary.
const main = (args, options = {}) => repairMain(args, {
  readLivePrImpl: async () => ({ prState: 'open', headSha: head, baseBranch: 'main' }),
  ...options,
});

function exhaustedPr(t) {
  const rootDir = mkdtempSync(join(tmpdir(), 'repair-dispatch-read-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const db = openReviewStateDb(rootDir);
  ensureReviewStateSchema(db);
  db.prepare(`INSERT INTO reviewed_prs(repo,pr_number,reviewed_at,reviewer,pr_state,
    review_status,reviewer_head_sha,rereview_reason)
    VALUES (?,?,'2026-01-01T00:00:00Z','synthetic','open','posted',?,?)`)
    .run(repo, prNumber, head, 'closure-retry-exhausted');
  db.close();
  return rootDir;
}

function closerLease(rootDir, status = 'dispatched') {
  const path = amaCloserLeaseFilePath(rootDir, { repo, prNumber, headSha: head });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ repo, prNumber, headSha: head, status,
    lrqId: closerLaunch, acquiredAt: '2026-01-01T00:00:00Z' }));
}

// Mock only the SDK session and the physical lookup; keep the SDK's own reply
// parsing and retry-chain traversal so the real ownership rules run.
function mockSdk(t, { launchStatus = 'canceled', connect, lookup } = {}) {
  const sdk = dispatchReadTransport.sdk();
  const calls = { connect: 0, lookup: 0 };
  t.mock.method(dispatchReadTransport, 'sdk', () => ({ ...sdk,
    connect: async config => {
      calls.connect++;
      if (connect) return connect(config);
      return { sessionToken: 'synthetic-session', endpoint_url: config.endpoint_url };
    },
    readSessionDispatchLookup: async selector => {
      calls.lookup++;
      if (lookup) return lookup(selector);
      if (selector.project_ref) return pairedDispatchAbsence(selector);
      const row = { launch_request_id: selector.launch_request_ids[0], status: launchStatus,
        repo, pr_number: prNumber, ticket_ref: 'SYNTHETIC-1' };
      return { schema_version: 1, status: 'found', complete: true,
        roots: [row.launch_request_id], items: [row], retry_edges: [] };
    },
  }));
  return calls;
}
const argv = (rootDir, project = 'fixture-project') =>
  [rootDir, repo, String(prNumber), head, 'repair-submit-synthetic', 'false', '', '', project];
// A fresh endpoint per test keeps the read client's module session cache apart.
let endpoint = 0;
const freshEnv = () => ({ APP_CONTRACT_ENDPOINT_URL: `https://fixture.invalid/repair-${++endpoint}` });

for (const { name, allowed, rounds = 2, state = 'absent-unfenced', lookupFailure,
  automatic, legacy, movedHead, capped, counterBump, pageFailure } of [
  { name: 'operator PR update after budget exhaustion', allowed: true },
  { name: 'scoped reservation at a moved head and at the cap', allowed: true, movedHead: true, capped: true },
  { name: 'legacy CWP conflict still needs an enqueue fence', legacy: true, movedHead: true, capped: true },
  { name: 'cap notification throws after commit', allowed: true, capped: true, pageFailure: true },
  { name: 'watcher increments absence during preflight', allowed: true, counterBump: true },
  { name: 'budget available', rounds: 0 },
  { name: 'persisted live owner', state: 'live' },
  { name: 'owner appears live during preflight', lookupFailure: 'live' },
  { name: 'transport failure after durable absence', lookupFailure: 'transport' },
  { name: 'automatic or hammer request', automatic: true },
]) test(`operator repair supersession: ${name}`, async t => {
  const rootDir = exhaustedPr(t);
  const identity = { repo, prNumber };
  const projectRef = legacy ? undefined : 'fixture-project';
  const oldKey = legacy ? `cwp-${'e'.repeat(24)}` : 'synthetic-old-owner';
  for (let round = 1; round <= rounds; round++) {
    recordPrRound(rootDir, { ...identity, roundId: `synthetic-round-${round}`,
      kind: PR_ROUND_KINDS.FOLLOW_UP_BLOCKING });
  }
  if (allowed) {
    const db = openReviewStateDb(rootDir);
    try { db.prepare('UPDATE reviewed_prs SET rereview_reason = NULL').run(); }
    finally { db.close(); }
  }
  mutateRepairEpochs(rootDir, identity, ledger => {
    ledger.attemptCount = 3;
    ledger.targetAttemptCount = 2;
    ledger.lifetimeAttemptCount = 4;
    ledger.selfErrorRefunds = { fixture: ['lrq_synthetic_refund'] };
  });
  if (capped) {
    reserveRepairEpoch({ rootDir, ...identity, headSha: head, ownerKey: 'synthetic-earlier-owner',
      cause: 'conflict-without-owner' });
    mutateRepairEpochs(rootDir, identity, ledger => {
      ledger.repairEpochs[0].terminalAt = '2026-01-01T00:00:00Z';
    });
  }
  const reservedAt = Date.parse('2026-01-01T00:00:00Z');
  reserveRepairEpoch({ rootDir, ...identity, headSha: head, ownerKey: oldKey,
    cause: 'conflict-without-owner', dispatchProjectRef: projectRef, now: new Date(reservedAt).toISOString() });
  const readImpl = async () => ({ ok: true, roots: [],
    absenceProof: { version: 1, kind: 'canonical-exact-selector-absence' } });
  for (const elapsed of [REPAIR_ABSENCE_ESCALATE_MS, REPAIR_ABSENCE_ESCALATE_MS + REPAIR_OWNER_OBSERVE_MS]) {
    await reconcileRepairOwner({ rootDir, ...identity, headSha: head, now: reservedAt + elapsed,
      readImpl, observeWait: async () => {} });
  }
  const prior = pendingRepairEpoch(rootDir, identity);
  assert.equal(prior.ownerState, 'absent-unfenced');
  assert.equal(prior.absentObservations, 2);
  if (state === 'live') mutateRepairEpochs(rootDir, identity, ledger => {
    ledger.repairEpochs.at(-1).ownerState = state;
  });
  const before = readHammerRetryCapLedger(rootDir, identity);
  let scoped = false;
  mockSdk(t, { lookup: selector => {
    if (selector.idempotency_key?.startsWith('repair-read-preflight-')) {
      scoped = true;
      if (counterBump) mutateRepairEpochs(rootDir, identity, ledger => {
        ledger.repairEpochs.at(-1).absentObservations++;
        ledger.repairEpochs.at(-1).ownerObservedAt = '2026-01-01T00:11:00Z';
      });
      return pairedDispatchAbsence(selector);
    }
    if (lookupFailure === 'transport') throw Object.assign(new Error('synthetic outage'), { status: 503 });
    if (lookupFailure === 'live' && scoped) {
      const row = { launch_request_id: 'lrq_synthetic_live', status: 'running',
        idempotency_key: oldKey, target_repo: repo, head_sha: head, project_ref: projectRef };
      return { schema_version: 1, status: 'found', complete: true, roots: [row.launch_request_id],
        items: [row], retry_edges: [] };
    }
    return pairedDispatchAbsence(selector, legacy ? 'cwp-repository-dispatch-read' : undefined);
  } });
  const args = argv(rootDir);
  if (movedHead) args[3] = 'b'.repeat(40);
  const env = { ...freshEnv(), ...(!automatic && { HQ_REPAIR_REQUEST_KIND: 'operator-pr-update' }) };
  const pages = [];
  let deliveries = 0;
  let committedWhenPageFailed;
  const pageRepairCapImpl = async args => {
    pages.push(args);
    return pageRepairCap({ ...args, observeImpl: wait => observeClosureWait({
      ...wait, pageImpl: async () => {
        if (pageFailure && pages.length === 1) {
          committedWhenPageFailed = pendingRepairEpoch(rootDir, identity);
          throw new Error('synthetic private transport failure');
        }
        deliveries++;
      },
    }) });
  };
  const result = await main(args, { env, pageRepairCapImpl });
  const after = readHammerRetryCapLedger(rootDir, identity);
  if (!allowed) {
    assert.equal(result.reason, legacy ? 'repair-cwp-enqueue-fence-required' : 'repair-owned');
    assert.deepEqual(after, before);
    assert.equal(pages.length, 0);
    return;
  }
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.notificationWarning, pageFailure ? 'repair-cap-notification-failed' : undefined);
  if (pageFailure) assert.deepEqual(committedWhenPageFailed, result.epoch);
  assert.equal(result.epoch.baseHead, args[3]);
  assert.equal(result.epoch.supersedesEpochId, prior.id);
  const retired = after.repairEpochs.at(-2);
  assert.ok(retired.terminalAt);
  assert.deepEqual(after, { ...before, repairEpochs: [
    ...before.repairEpochs.slice(0, -1),
    { ...prior, ...(counterBump && { absentObservations: 3, ownerObservedAt: '2026-01-01T00:11:00Z' }),
      terminalAt: retired.terminalAt,
      supersededBy: { kind: 'operator-repair', launch: args[4], at: retired.terminalAt } },
    result.epoch,
  ] });
  assert.equal(pages.length, capped ? 1 : 0, 'supersession beyond the cap must page');
  if (capped) assert.deepEqual(pages[0].epochs, after.repairEpochs);
  assert.equal(bindRepairHead({ rootDir, ...identity, epochId: prior.id, headSha: 'f'.repeat(40) }), null);
  assert.equal(reserveRepairEpoch({ rootDir, ...identity, headSha: head, ownerKey: oldKey,
    cause: 'conflict-without-owner' }).reason, 'repair-worker-terminal');
  assert.deepEqual(readHammerRetryCapLedger(rootDir, identity), after);
  if (capped) {
    assert.equal((await main(args, { env, pageRepairCapImpl })).replayed, true);
    assert.equal(pages.length, 2, 'replay observes the cap page again');
    assert.deepEqual(readHammerRetryCapLedger(rootDir, identity), after);
    mutateRepairEpochs(rootDir, identity, ledger => {
      Object.assign(ledger.repairEpochs.at(-1), {
        reservedAt: '2026-01-01T00:00:00Z', ownerObservedAt: '2026-01-01T00:11:00Z',
        ownerState: 'absent-unfenced', absentObservations: 2,
      });
    });
    const nextArgs = [...args];
    nextArgs[3] = 'c'.repeat(40);
    nextArgs[4] += '-next';
    const next = await main(nextArgs, { env, pageRepairCapImpl });
    assert.equal(next.epoch.supersedesEpochId, result.epoch.id);
    assert.equal(pages.length, 3, 'another above-cap replacement observes the same page');
    assert.equal(pages.at(-1).epochs.length, 4);
    assert.equal(deliveries, 1, 'delivery deduplicates across replays, heads and chains');
  }
});

test('final-fix recovery accepts a live publication after its reviewed revision', async t => {
  const rootDir = exhaustedPr(t);
  const identity = { repo, prNumber };
  const ownerKey = 'ffa-' + 'f'.repeat(64);
  const dispatchProjectRef = 'pr-merge-orchestration';
  const { epoch } = reserveRepairEpoch({ rootDir, ...identity, headSha: head, ownerKey,
    cause: 'review-cycle-exhausted', dispatchProjectRef });
  const reviewedHead = 'a'.repeat(40);
  const db = openReviewStateDb(rootDir);
  try {
    db.prepare('UPDATE reviewed_prs SET revision_ref=?, reviewer_head_sha=?')
      .run(reviewedHead, reviewedHead);
  } finally { db.close(); }
  const before = readHammerRetryCapLedger(rootDir, identity);
  mockSdk(t);
  const reads = [];
  const result = await main([rootDir, repo, String(prNumber), head, ownerKey,
    'false', '', '', dispatchProjectRef, epoch.id], { env: freshEnv(),
    readLivePrImpl: async (repository, number, options) => {
      reads.push({ repository, number, timeoutMs: options.timeoutMs });
      return { prState: 'open', headSha: head, baseBranch: 'main' };
    } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.replayed, true);
  assert.equal(reads.length, 2, 'recheck the live head after scoped owner absence');
  assert.ok(reads.every(read => read.repository === repo && read.number === prNumber
    && read.timeoutMs === 15000));
  assert.deepEqual(readHammerRetryCapLedger(rootDir, identity), before);
  const after = openReviewStateDb(rootDir);
  try {
    assert.deepEqual(after.prepare('SELECT revision_ref,reviewer_head_sha FROM reviewed_prs').get(),
      { revision_ref: reviewedHead, reviewer_head_sha: reviewedHead });
  } finally { after.close(); }
});

for (const [scenario, expected] of [
  ['closed review row', 'final-fix-pr-not-open'],
  ['missing review row', 'final-fix-pr-not-open'],
  ['moved live head', 'final-fix-head-mismatch'],
  ['closed live PR', 'final-fix-pr-not-open'],
  ['unavailable live PR', 'final-fix-pr-unavailable'],
  ['failed live PR read', 'final-fix-pr-unavailable'],
  ['live closer', 'closer-owned-or-unknown'],
  ['unknown closer', 'closer-owned-or-unknown'],
  ['malformed closer lease', { name: 'SyntaxError' }],
  ['in-progress follow-up', 'remediation-owned'],
  ['transport failure', 'final-fix-owner-absence-unproven'],
  ['follow-up ticket', /invalid repair request/],
  ['launcher PID', /invalid repair request/],
  ['non-final-fix key', /invalid repair request/],
]) test(`final-fix recovery refuses ${scenario}`, async t => {
  const rootDir = exhaustedPr(t);
  const identity = { repo, prNumber };
  const ownerKey = `ffa-${'f'.repeat(64)}`;
  const dispatchProjectRef = 'pr-merge-orchestration';
  const { epoch } = reserveRepairEpoch({ rootDir, ...identity, headSha: head, ownerKey,
    cause: 'review-cycle-exhausted', dispatchProjectRef });
  const before = readHammerRetryCapLedger(rootDir, identity);
  const args = [rootDir, repo, String(prNumber), head, ownerKey, 'false', '', '', dispatchProjectRef, epoch.id];

  if (scenario.endsWith('review row')) {
    const db = openReviewStateDb(rootDir);
    try {
      if (scenario === 'closed review row') db.prepare("UPDATE reviewed_prs SET pr_state = 'closed'").run();
      if (scenario === 'missing review row') db.prepare('DELETE FROM reviewed_prs').run();
    } finally { db.close(); }
  }
  if (scenario.endsWith('closer')) closerLease(rootDir);
  if (scenario === 'malformed closer lease') {
    closerLease(rootDir);
    writeFileSync(amaCloserLeaseFilePath(rootDir, { ...identity, headSha: head }), '{');
  }
  if (scenario === 'in-progress follow-up') {
    const path = join(rootDir, 'data', 'follow-up-jobs', 'in-progress', 'competing.json');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...identity, jobId: 'competing', status: 'in_progress' }));
  }
  if (scenario === 'follow-up ticket') args[6] = 'competing';
  if (scenario === 'launcher PID') args[7] = '123';
  if (scenario === 'non-final-fix key') args[4] = 'repair-submit-synthetic';
  const calls = mockSdk(t, {
    launchStatus: 'running',
    lookup: ['unknown closer', 'transport failure'].includes(scenario)
      ? () => { throw Object.assign(new Error('synthetic outage'), { status: 503 }); }
      : undefined,
  });

  const recover = () => main(args, { env: freshEnv(), readLivePrImpl: async () => {
    if (scenario === 'failed live PR read') throw new Error('synthetic unavailable reader');
    if (scenario === 'unavailable live PR') return null;
    return { prState: scenario === 'closed live PR' ? 'closed' : 'open',
      headSha: scenario === 'moved live head' ? 'e'.repeat(40) : head, baseBranch: 'main' };
  } });
  if (typeof expected !== 'string') {
    await assert.rejects(recover, expected);
  } else {
    const result = await recover();
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.reason, expected);
  }
  if (!['live closer', 'unknown closer', 'transport failure'].includes(scenario)) {
    assert.equal(calls.lookup, 0);
  }
  assert.deepEqual(readHammerRetryCapLedger(rootDir, identity), before);
});

for (const [scenario, reason] of [
  ['head moves', 'final-fix-head-mismatch'],
  ['PR closes', 'final-fix-pr-not-open'],
  ['follow-up appears', 'remediation-owned'],
]) test('final-fix recovery refuses when ' + scenario + ' during the live-head recheck', async t => {
  const rootDir = exhaustedPr(t);
  const identity = { repo, prNumber };
  const ownerKey = 'ffa-' + 'f'.repeat(64);
  const dispatchProjectRef = 'pr-merge-orchestration';
  const { epoch } = reserveRepairEpoch({ rootDir, ...identity, headSha: head, ownerKey,
    cause: 'review-cycle-exhausted', dispatchProjectRef });
  const before = readHammerRetryCapLedger(rootDir, identity);
  mockSdk(t);
  let reads = 0;
  const result = await main([rootDir, repo, String(prNumber), head, ownerKey,
    'false', '', '', dispatchProjectRef, epoch.id], { env: freshEnv(),
    readLivePrImpl: async () => {
      reads++;
      if (reads === 2 && scenario === 'follow-up appears') {
        const path = join(rootDir, 'data', 'follow-up-jobs', 'pending', 'competing.json');
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify({ ...identity, jobId: 'competing', status: 'pending' }));
      }
      return { prState: reads === 2 && scenario === 'PR closes' ? 'closed' : 'open',
        headSha: reads === 2 && scenario === 'head moves' ? 'e'.repeat(40) : head,
        baseBranch: 'main' };
    } });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.reason, reason);
  assert.equal(reads, 2);
  assert.deepEqual(readHammerRetryCapLedger(rootDir, identity), before);
});

for (const [ownerState, allowed] of [
  [undefined, true], [null, true], ['unknown', true], ['absent', true], ['absent-unfenced', true],
  ['live', false], ['terminal', false], ['unexpected', false],
]) test(`final-fix recovery pre-checks owner state ${ownerState} before dispatch reads`, async t => {
  const rootDir = exhaustedPr(t);
  const identity = { repo, prNumber };
  const ownerKey = `ffa-${'f'.repeat(64)}`;
  const dispatchProjectRef = 'pr-merge-orchestration';
  const { epoch } = reserveRepairEpoch({ rootDir, ...identity, headSha: head, ownerKey,
    cause: 'review-cycle-exhausted', dispatchProjectRef });
  if (ownerState !== undefined) {
    mutateRepairEpochs(rootDir, identity, ledger => {
      ledger.repairEpochs[0].ownerState = ownerState;
    });
  }
  const before = readHammerRetryCapLedger(rootDir, identity);
  const calls = mockSdk(t);
  const result = await main([rootDir, repo, String(prNumber), head, ownerKey,
    'false', '', '', dispatchProjectRef, epoch.id], { env: freshEnv() });
  assert.equal(result.ok, allowed);
  if (allowed) {
    assert.equal(result.replayed, true);
    assert.equal(calls.lookup, 1, 'eligible owners still require paired dispatch absence');
  } else {
    assert.equal(result.reason, 'final-fix-reservation-changed');
    assert.equal(calls.connect, 0, 'ineligible owners refuse before dispatch preparation');
    assert.equal(calls.lookup, 0, 'ineligible owners refuse without a dispatch lookup');
  }
  assert.deepEqual(readHammerRetryCapLedger(rootDir, identity), before);
});

test('final-fix recovery only replays the selected unbound owner under paired absence', async t => {
  const rootDir = exhaustedPr(t);
  const identity = { repo, prNumber };
  const ownerKey = `ffa-${'f'.repeat(64)}`;
  const dispatchProjectRef = 'pr-merge-orchestration';
  const { epoch } = reserveRepairEpoch({ rootDir, ...identity, headSha: head, ownerKey,
    cause: 'review-cycle-exhausted', dispatchProjectRef });
  mutateRepairEpochs(rootDir, identity, ledger => {
    Object.assign(ledger.repairEpochs[0], { ownerState: 'absent-unfenced', ownerLaunch: null, absentObservations: 3 });
  });
  const before = readHammerRetryCapLedger(rootDir, identity);
  let response = pairedDispatchAbsence;
  const calls = mockSdk(t, { lookup: selector => response(selector) });
  const recoveryArgs = [rootDir, repo, String(prNumber), head, ownerKey, 'false', '', '', dispatchProjectRef, epoch.id];
  const recover = (args = recoveryArgs) => main(args, { env: freshEnv() });
  assert.equal((await recover([...recoveryArgs.slice(0, -1), `repair-${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}`])).reason,
    'final-fix-reservation-changed');
  assert.equal(calls.lookup, 0);
  response = selector => pairedDispatchAbsence(selector, 'operator-exact-key');
  assert.equal((await recover()).reason, 'final-fix-owner-absence-unproven');
  response = selector => ({ ...pairedDispatchAbsence(selector), scope_complete: false });
  assert.equal((await recover()).reason, 'final-fix-owner-absence-unproven');
  response = pairedDispatchAbsence;
  const queuePath = join(rootDir, 'data', 'follow-up-jobs', 'pending', 'competing.json');
  mkdirSync(dirname(queuePath), { recursive: true });
  writeFileSync(queuePath, JSON.stringify({ ...identity, jobId: 'competing', status: 'pending' }));
  assert.equal((await recover()).reason, 'remediation-owned');
  rmSync(queuePath);
  const replay = await recover();
  assert.deepEqual(replay, { ok: true, protocol: 'final-fix-recovery-v1', replayed: true,
    epoch: before.repairEpochs[0] });
  assert.deepEqual(readHammerRetryCapLedger(rootDir, identity), before);

  // An owner appears between the snapshot and the compare-and-read.
  response = selector => {
    mutateRepairEpochs(rootDir, identity, ledger => {
      ledger.repairEpochs[0].ownerLaunch = 'lrq_winner';
    });
    return pairedDispatchAbsence(selector);
  };
  assert.equal((await recover()).reason, 'final-fix-reservation-changed');
  assert.equal(pendingRepairEpoch(rootDir, identity).ownerLaunch, 'lrq_winner');
});

test('a denied project/repository read stops a new repair before any reservation', async t => {
  const rootDir = exhaustedPr(t);
  const identity = { repo, prNumber };
  const before = readHammerRetryCapLedger(rootDir, identity);
  const calls = mockSdk(t, { lookup: () => {
    throw new Error('app-contract dispatch_scope_denied: synthetic entitlement denial');
  } });
  const result = await main(argv(rootDir, 'legacy-project'), { env: freshEnv() });
  assert.equal(result.ok, false, JSON.stringify({ result, ledger: readHammerRetryCapLedger(rootDir, identity), calls }));
  assert.equal(result.reason, 'repair-dispatch-read-scope-denied');
  assert.deepEqual(result.scope, { appId: 'adversarial-review', repo, projectRef: 'legacy-project' });
  assert.equal(calls.lookup, 1);
  assert.deepEqual(readHammerRetryCapLedger(rootDir, identity), before);
});

for (const [kind, reply, lookups] of [
  ['transport outage', () => { throw new Error('app-contract dispatch_read_unavailable: synthetic outage'); }, 2],
  ['unsupported selector', () => { throw new Error('app-contract invalid_dispatch_selector: old endpoint'); }, 1],
  ['filtered empty', selector => ({ ...pairedDispatchAbsence(selector), scope_complete: false }), 1],
  ['retirement-only grant', selector => pairedDispatchAbsence(selector, 'operator-exact-key'), 1],
  ['mismatched proof', selector => pairedDispatchAbsence({ ...selector, repo: 'other/widgets' }), 1],
]) test(`new repair scope stays unproven on ${kind}`, async t => {
  const rootDir = exhaustedPr(t);
  const calls = mockSdk(t, { lookup: reply });
  const result = await main(argv(rootDir), { env: freshEnv() });
  assert.equal(result.reason, 'repair-dispatch-read-scope-unproven');
  assert.equal(calls.lookup, lookups);
  assert.equal(readHammerRetryCapLedger(rootDir, { repo, prNumber }), null);
});

test('a lease naming a canceled closer launch reads as terminal and the reservation proceeds', async t => {
  const rootDir = exhaustedPr(t);
  closerLease(rootDir);
  const calls = mockSdk(t, { launchStatus: 'canceled' });
  const env = freshEnv();
  const result = await main(argv(rootDir), { env });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.match(result.epoch.id, /^repair-/);
  assert.equal(env.ADVERSARIAL_DISPATCH_READS_ENABLED, '1');
  assert.equal(calls.connect, 1);
  assert.equal(calls.lookup, 2);
});

for (const launchStatus of ['dispatched', 'running']) {
  test(`a live closer launch (${launchStatus}) still refuses as closer-owned-or-unknown`, async t => {
    const rootDir = exhaustedPr(t);
    closerLease(rootDir);
    mockSdk(t, { launchStatus });
    const result = await main(argv(rootDir), { env: freshEnv() });
    assert.deepEqual(result, { ok: false, reason: 'closer-owned-or-unknown' });
    assert.equal(pendingRepairEpoch(rootDir, { repo, prNumber }), null);
  });
}

test('a canceled launch with a live retry stays owned', async t => {
  const rootDir = exhaustedPr(t);
  closerLease(rootDir);
  mockSdk(t, { lookup: () => {
    const parent = { launch_request_id: closerLaunch, status: 'canceled', repo, pr_number: prNumber };
    const child = { launch_request_id: 'lrq_synthetic_retry', status: 'running', repo, pr_number: prNumber };
    return { schema_version: 1, status: 'found', complete: true, roots: [closerLaunch],
      items: [parent, child], retry_edges: [{ parent: closerLaunch, child: child.launch_request_id }] };
  } });
  const result = await main(argv(rootDir), { env: freshEnv() });
  assert.deepEqual(result, { ok: false, reason: 'closer-owned-or-unknown' });
});

for (const failure of ['transient', 'timeout', 'unproven-absence']) {
  test(`a ${failure} ownership read stays fail-closed as closer-owned-or-unknown`, async t => {
    const rootDir = exhaustedPr(t);
    closerLease(rootDir);
    mockSdk(t, { lookup: () => {
      if (failure === 'transient') throw Object.assign(new Error('synthetic outage'), { status: 503 });
      if (failure === 'timeout') throw Object.assign(new Error('synthetic timeout'), { code: 'ETIMEDOUT' });
      return { schema_version: 1, status: 'not_found', complete: true, roots: [], items: [], retry_edges: [] };
    } });
    const result = await main(argv(rootDir), { env: { ...freshEnv(), ADVERSARIAL_DISPATCH_READS_ENABLED: '1' } });
    assert.deepEqual(result, { ok: false, reason: 'closer-owned-or-unknown' });
  });
}

test('a failed context preparation refuses with the typed reason, never closer ownership', async t => {
  const rootDir = exhaustedPr(t);
  closerLease(rootDir);
  const calls = mockSdk(t, { connect: async () => { throw new Error('synthetic bootstrap refusal'); } });
  const env = freshEnv();
  const result = await main(argv(rootDir), { env });
  assert.deepEqual(result, { ok: false, reason: 'dispatch-read-context-unavailable',
    detail: 'session-bootstrap-failed' });
  assert.equal(calls.lookup, 0);
  assert.equal(env.ADVERSARIAL_DISPATCH_READS_ENABLED, undefined);
  assert.equal(pendingRepairEpoch(rootDir, { repo, prNumber }), null);
});

test('a preparation that leaves dispatch reads disabled refuses with the typed reason', async t => {
  const rootDir = exhaustedPr(t);
  closerLease(rootDir);
  const calls = mockSdk(t);
  for (const prepare of [async () => ({ ok: true }), () => { throw new Error('synthetic'); }]) {
    const result = await main(argv(rootDir), { env: freshEnv(), prepareDispatchReadContextImpl: prepare });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'dispatch-read-context-unavailable');
  }
  assert.equal(calls.lookup, 0);
});

test('a pending repair epoch is observed through the prepared context', async t => {
  const rootDir = exhaustedPr(t);
  const prior = reserveRepairEpoch({ rootDir, repo, prNumber, headSha: head, ownerKey: 'repair-submit-prior',
    cause: 'closure-retry-exhausted', now: '2026-01-01T00:00:00Z' }).epoch;
  const selectors = [];
  mockSdk(t, { lookup: selector => {
    selectors.push(selector);
    if (selector.project_ref) return pairedDispatchAbsence(selector);
    const row = { launch_request_id: 'lrq_synthetic_repair', status: 'canceled',
      idempotency_key: prior.ownerKey, target_repo: repo, head_sha: head, identity_ambiguous: false };
    return { schema_version: 1, status: 'found', complete: true, roots: [row.launch_request_id],
      items: [row], retry_edges: [] };
  } });
  const result = await main(argv(rootDir), { env: freshEnv() });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.notEqual(result.epoch.id, prior.id);
  assert.equal(selectors[0].idempotency_key, 'repair-submit-prior');
});

test('a newly observed publication fences a successor during scope verification', async t => {
  const rootDir = exhaustedPr(t);
  const identity = { repo, prNumber };
  const prior = reserveRepairEpoch({ rootDir, ...identity, headSha: head, ownerKey: 'repair-submit-prior',
    cause: 'closure-retry-exhausted' }).epoch;
  const priorLaunch = 'lrq_fixture_prior';
  const publicationHead = 'a'.repeat(40);
  mockSdk(t, { lookup: selector => {
    if (selector.project_ref) {
      mutateRepairEpochs(rootDir, identity, ledger => {
        Object.assign(ledger.repairEpochs[0], { publicationHead, publicationLaunch: priorLaunch });
      });
      return pairedDispatchAbsence(selector);
    }
    const row = { launch_request_id: priorLaunch, status: 'canceled',
      idempotency_key: prior.ownerKey, target_repo: repo, head_sha: head, identity_ambiguous: false };
    return { schema_version: 1, status: 'found', complete: true, roots: [priorLaunch],
      items: [row], retry_edges: [] };
  } });
  const result = await main(argv(rootDir), { env: freshEnv() });
  assert.equal(result.reason, 'repair-owned');
  assert.deepEqual(readHammerRetryCapLedger(rootDir, identity).repairEpochs,
    [{ ...prior, publicationHead, publicationLaunch: priorLaunch }]);
});

const execute = promisify(execFile);
const helper = fileURLToPath(new URL('../bin/repair-in-place.mjs', import.meta.url));

for (const [scenario, makeLeaseEntry, diagnostic] of [
  ['unreadable lease', path => mkdirSync(path), /EISDIR/],
  ['vanished lease target', path => symlinkSync('missing-lease.json', path), /closer lease snapshot unavailable/],
]) test(`final-fix recovery CLI fails closed on ${scenario}`, async t => {
  const rootDir = exhaustedPr(t);
  const identity = { repo, prNumber };
  const ownerKey = `ffa-${'f'.repeat(64)}`;
  const dispatchProjectRef = 'pr-merge-orchestration';
  const { epoch } = reserveRepairEpoch({ rootDir, ...identity, headSha: head, ownerKey,
    cause: 'review-cycle-exhausted', dispatchProjectRef });
  const before = readHammerRetryCapLedger(rootDir, identity);
  const path = amaCloserLeaseFilePath(rootDir, { ...identity, headSha: head });
  mkdirSync(dirname(path), { recursive: true });
  makeLeaseEntry(path);
  const args = [rootDir, repo, String(prNumber), head, ownerKey, 'false', '', '', dispatchProjectRef, epoch.id];

  await assert.rejects(execute(process.execPath, [helper, ...args], {
    env: { HQ_ROOT: rootDir, NODE_OPTIONS: process.env.NODE_OPTIONS },
    timeout: 15000,
  }), error => {
    assert.equal(error.code, 75);
    assert.equal(error.stdout, '');
    assert.match(withoutConfigSchemaDiagnostics(error.stderr), diagnostic);
    return true;
  });
  assert.deepEqual(readHammerRetryCapLedger(rootDir, identity), before);
});

const project = 'fixture-project';
const ownerKey = 'fixture-original-key';
const launch = 'lrq_fixture_owner';
const isPreflight = selector => selector.idempotency_key?.startsWith('repair-read-preflight-');

function assertScopeProbe(selector, expectedProject) {
  assert.match(selector.idempotency_key, /^repair-read-preflight-[0-9a-f-]{36}$/);
  assert.deepEqual(selector, { idempotency_key: selector.idempotency_key, project_ref: expectedProject, repo });
}

for (const [kind, lookupCount, remaining, exitCode, legacy = false] of [
  ['terminal', 3, 2, 0], ['live retry', 2, 1, 75], ['retry unavailable', 2, 1, 75],
  ['foreign head', 1, 1, 75], ['foreign repo', 1, 1, 75],
  ['grant denied', 1, 1, 75], ['filtered empty', 1, 1, 75],
  ['canonical empty', 1, 1, 75], ['moved head', 0, 1, 75],
  ['filtered empty', 1, 1, 75, true], ['canonical empty', 1, 1, 75, true],
  ['terminal', 3, 2, 0, true], ['denied successor', 3, 1, 75], ['denied initial', 1, 0, 75],
]) test(`installed SDK repair CLI ${legacy ? 'legacy unscoped ' : ''}${kind}`, async t => {
  const rootDir = exhaustedPr(t);
  const bootstrap = join(rootDir, 'apps', 'bootstrap');
  mkdirSync(bootstrap, { recursive: true });
  writeFileSync(join(bootstrap, 'adversarial-review.bearer'), 'fixture-bootstrap');
  const argvFor = (sha, key, projectRef) => [
    rootDir, repo, String(prNumber), sha, key, 'false', '', '', projectRef,
  ];
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(APP_CONTRACT_|HCP_|HQ_LAUNCH_REQUEST_ID$|ADVERSARIAL_(DISPATCH_READS|WORKER_OBSERVATIONS)_ENABLED$)/.test(key)));
  const run = async (sha, key, projectRef) => {
    const options = { env: { ...env, HQ_ROOT: rootDir, APP_CONTRACT_ENDPOINT_URL: endpointUrl }, timeout: 15000 };
    const output = await execute(process.execPath, [helper, ...argvFor(sha, key, projectRef)], options)
      .then(result => ({ ...result, code: 0 }), error => error);
    assert.equal(withoutConfigSchemaDiagnostics(output.stderr), '');
    return { code: output.code, receipt: JSON.parse(output.stdout) };
  };
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const selector = JSON.parse(raw);
    requests.push({ path: req.url, auth: req.headers.authorization, selector });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/register') return res.end(JSON.stringify({ session_token: 'fixture-session' }));
    const denied = kind === 'grant denied' || kind === 'denied initial'
      || (kind === 'denied successor' && isPreflight(selector));
    if (denied || (kind === 'retry unavailable' && selector.include_retry_chain)) {
      res.writeHead(403);
      return res.end(JSON.stringify({ error: { code: 'dispatch_scope_denied', message: 'synthetic denial' } }));
    }
    if (isPreflight(selector)) return res.end(JSON.stringify(pairedDispatchAbsence(selector)));
    const empty = { schema_version: 1, status: 'not_found', complete: true, items: [], roots: [], retry_edges: [] };
    if (kind === 'filtered empty') return res.end(JSON.stringify(empty));
    if (kind === 'canonical empty') return res.end(JSON.stringify({ ...empty, scope_complete: true,
      absence_proof: { version: 1, kind: 'canonical-exact-selector-absence', selector,
        // The grant identifier does not authorize retirement of repair custody.
        grant_id: 'project-repository-dispatch-read',
        observed_at: new Date().toISOString() } }));
    const row = { launch_request_id: launch, idempotency_key: ownerKey, status: 'canceled',
      target_repo: kind === 'foreign repo' ? 'other/widgets' : repo,
      head_sha: kind === 'foreign head' ? 'e'.repeat(40) : head, identity_ambiguous: false };
    const retry = selector.include_retry_chain && kind === 'live retry';
    return res.end(JSON.stringify({ ...empty, status: 'found', roots: [launch],
      items: retry ? [row, { launch_request_id: 'lrq_fixture_retry', status: 'running' }] : [row],
      retry_edges: retry ? [{ parent: launch, child: 'lrq_fixture_retry' }] : [] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const endpointUrl = `http://127.0.0.1:${server.address().port}`;

  if (kind === 'denied initial') {
    const refused = await run(head, ownerKey, project);
    assert.equal(refused.code, 75);
    assert.equal(refused.receipt.reason, 'repair-dispatch-read-scope-denied');
    assert.equal(readHammerRetryCapLedger(rootDir, { repo, prNumber }), null);
    assert.deepEqual(requests.map(({ auth, path }) => [path, auth]), [
      ['/v1/register', 'Bearer fixture-bootstrap'], ['/v1/dispatch/lookup', 'Bearer fixture-session'],
    ]);
    assertScopeProbe(requests[1].selector, project);
    return;
  }
  reserveRepairEpoch({ rootDir, repo, prNumber, headSha: head, ownerKey,
    cause: 'closure-retry-exhausted', dispatchProjectRef: legacy ? undefined : project });
  if (legacy || kind === 'canonical empty') {
    mutateRepairEpochs(rootDir, { repo, prNumber }, ledger => {
      ledger.repairEpochs[0].reservedAt = '2026-01-01T00:00:00Z';
      if (legacy) {
        ledger.repairEpochs[0].ownerState = 'unknown';
        ledger.repairEpochs[0].ownerLaunch = null;
      }
    });
  }
  const before = readHammerRetryCapLedger(rootDir, { repo, prNumber });
  const successor = await run(kind === 'moved head' ? 'e'.repeat(40) : head, 'fresh-key', 'new-project');
  assert.equal(successor.code, exitCode);
  assert.equal(successor.receipt.ok, exitCode === 0);
  if (exitCode === 75) assert.equal(successor.receipt.reason,
    kind === 'denied successor' ? 'repair-dispatch-read-scope-denied' : 'repair-owned');
  const { repairEpochs } = readHammerRetryCapLedger(rootDir, { repo, prNumber });
  assert.equal(repairEpochs.length, remaining);
  assert.equal(repairEpochs[0].ownerKey, ownerKey);
  assert.equal(repairEpochs[0].reviewHead, null);
  assert.equal(Boolean(repairEpochs[0].terminalAt), exitCode === 0);
  if ((legacy && exitCode === 75) || kind === 'denied successor') {
    assert.deepEqual(readHammerRetryCapLedger(rootDir, { repo, prNumber }), before);
  }
  assert.equal(pendingRepairEpoch(rootDir, { repo, prNumber }).ownerKey, exitCode === 0 ? 'fresh-key' : ownerKey);
  if (!lookupCount) {
    assert.deepEqual(requests, []);
    return;
  }
  assert.equal(requests.length, 1 + lookupCount);
  assert.equal(requests[0].path, '/v1/register');
  assert.equal(requests[0].auth, 'Bearer fixture-bootstrap');
  assert.equal(requests[0].selector.app_id, 'adversarial-review');
  for (const request of requests.slice(1)) {
    assert.equal(request.path, '/v1/dispatch/lookup');
    assert.equal(request.auth, 'Bearer fixture-session');
  }
  assert.deepEqual(requests[1].selector, legacy ? { idempotency_key: ownerKey }
    : { idempotency_key: ownerKey, project_ref: project, repo });
  if (lookupCount >= 2) assert.deepEqual(requests[2].selector, {
    launch_request_ids: [launch], include_retry_chain: true,
  });
  if (lookupCount === 3) assertScopeProbe(requests[3].selector, 'new-project');
});

test('the first reservation records the exact project after an affirmative scoped read', async t => {
  const rootDir = exhaustedPr(t);
  const calls = mockSdk(t, { lookup: selector => {
    assertScopeProbe(selector, project);
    assert.equal(pendingRepairEpoch(rootDir, { repo, prNumber }), null);
    return pairedDispatchAbsence(selector);
  } });
  const result = await main(argv(rootDir), { env: freshEnv() });
  assert.equal(result.ok, true);
  assert.equal(result.epoch.dispatchProjectRef, project);
  assert.equal(calls.connect, 1);
  assert.equal(calls.lookup, 1);
});

test('missing project refuses a new epoch but permits exact legacy replay', async t => {
  const rootDir = exhaustedPr(t);
  const calls = mockSdk(t, { lookup: () => { throw new Error('unavailable'); } });
  const env = freshEnv();
  const request = argv(rootDir, '');
  const refused = await main(request, { env });
  assert.equal(refused.reason, 'repair-dispatch-project-required');
  assert.equal(calls.connect, 0);
  assert.equal(readHammerRetryCapLedger(rootDir, { repo, prNumber }), null);
  const prior = reserveRepairEpoch({ rootDir, repo, prNumber, headSha: head, ownerKey: request[4],
    cause: 'closure-retry-exhausted' }).epoch;
  const replay = await main(request, { env });
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.epoch, prior);
  assert.equal(calls.lookup, 1, 'only the preexisting owner lookup is made');
});

test('missing project refuses before closer observation and leaves its lease intact', async t => {
  const rootDir = exhaustedPr(t);
  closerLease(rootDir);
  const leaseFile = amaCloserLeaseFilePath(rootDir, { repo, prNumber, headSha: head });
  const before = readFileSync(leaseFile, 'utf8');
  const calls = mockSdk(t);
  const result = await main(argv(rootDir, ''), { env: freshEnv() });
  assert.equal(result.reason, 'repair-dispatch-project-required');
  assert.deepEqual(calls, { connect: 0, lookup: 0 });
  assert.equal(readFileSync(leaseFile, 'utf8'), before);
  assert.equal(readHammerRetryCapLedger(rootDir, { repo, prNumber }), null);
});

for (const error of [
  new Error('app-contract 403 synthetic denial'),
  Object.assign(new Error('synthetic denial'), { code: 'dispatch_read_scope_denied' }),
]) test(`scope preflight reports denial for ${error.code ?? 'plain 403'}`, async t => {
  const rootDir = exhaustedPr(t);
  mockSdk(t, { lookup: () => { throw error; } });
  const result = await main(argv(rootDir), { env: freshEnv() });
  assert.equal(result.reason, 'repair-dispatch-read-scope-denied');
  assert.equal(readHammerRetryCapLedger(rootDir, { repo, prNumber }), null);
});

test('retained conflict replay without a review row verifies the live PR and leaves the ledger intact', async t => {
  const rootDir = exhaustedPr(t);
  const identity = { repo, prNumber };
  const db = openReviewStateDb(rootDir);
  try { db.prepare('DELETE FROM reviewed_prs WHERE repo=? AND pr_number=?').run(repo, prNumber); }
  finally { db.close(); }
  const ownerKey = `in-place-repair-${'c'.repeat(64)}`;
  const dispatchProjectRef = 'fixture-project';
  const args = [rootDir, repo, String(prNumber), head, ownerKey, 'true', '', '', dispatchProjectRef];
  const calls = mockSdk(t);
  const env = freshEnv();
  const { epoch } = await main(args, { env });
  assert.equal(epoch.cause, 'conflict-without-owner');
  const ledgerPath = hammerRetryCapFilePath(rootDir, identity);
  const before = readFileSync(ledgerPath, 'utf8');
  const inode = statSync(ledgerPath).ino;

  const recoveryArgs = [...args, epoch.id];
  const refused = await main(recoveryArgs, { env,
    readLivePrImpl: async () => ({ prState: 'closed', headSha: head }) });
  assert.deepEqual(refused, { ok: false, reason: 'retained-repair-pr-not-open' });
  assert.equal(calls.lookup, 1, 'closed live PR must refuse before the owner lookup');

  let liveReads = 0;
  const result = await main(recoveryArgs, { env, readLivePrImpl: async () => {
    liveReads++;
    return { prState: 'open', headSha: head };
  } });
  assert.deepEqual(result, { ok: true, replayed: true, protocol: 'retained-repair-replay-v1', epoch });
  assert.equal(liveReads, 2);
  assert.equal(calls.lookup, 2);
  assert.equal(readFileSync(ledgerPath, 'utf8'), before);
  assert.equal(statSync(ledgerPath).ino, inode, 'replay must not atomically replace the ledger');
});

for (const [scenario, reason, detail] of [
  ['exact rescue project'],
  ['bootstrap missing', 'dispatch-read-context-unavailable', 'bootstrap-credential-missing'],
  ['bootstrap missing during closer lease inspection', 'dispatch-read-context-unavailable', 'bootstrap-credential-missing'],
  ['grant denied', 'retained-repair-owner-absence-unproven', 'dispatch-scope-denied'],
  ['filtered empty', 'retained-repair-owner-absence-unproven', 'dispatch-absence-unproven'],
  ['owner appeared', 'retained-repair-owner-absence-unproven', 'dispatch-owner-present'],
  ['persisted live owner', 'retained-repair-reservation-changed'],
  ['wrong project', 'retained-repair-reservation-changed'],
  ['stale head', 'retained-repair-head-mismatch'],
]) test(`retained native repair replay requires exact custody: ${scenario}`, async t => {
  const rootDir = exhaustedPr(t);
  const identity = { repo, prNumber };
  const ownerKey = `in-place-repair-${'c'.repeat(64)}`;
  const dispatchProjectRef = 'adversarial-review-pipeline-reliability';
  const { epoch } = reserveRepairEpoch({ rootDir, ...identity, headSha: head, ownerKey,
    cause: 'review-cycle-exhausted', dispatchProjectRef });
  mutateRepairEpochs(rootDir, identity, ledger => {
    Object.assign(ledger.repairEpochs[0], { ownerState: scenario === 'persisted live owner' ? 'live' : 'unknown', ownerLaunch: null });
  });
  if (scenario === 'bootstrap missing during closer lease inspection') closerLease(rootDir);
  const before = readHammerRetryCapLedger(rootDir, identity);
  mockSdk(t, { lookup: selector => {
    assert.deepEqual(selector, { idempotency_key: ownerKey, project_ref: dispatchProjectRef, repo });
    if (scenario === 'grant denied') throw Object.assign(new Error('private endpoint reply'), { status: 403 });
    if (scenario === 'filtered empty') return { ...pairedDispatchAbsence(selector), scope_complete: false };
    if (scenario === 'owner appeared') {
      const row = { launch_request_id: 'lrq_appeared', status: 'running',
        idempotency_key: ownerKey, target_repo: repo, head_sha: head, project_ref: dispatchProjectRef };
      return { schema_version: 1, status: 'found', complete: true, roots: [row.launch_request_id],
        items: [row], retry_edges: [] };
    }
    return pairedDispatchAbsence(selector);
  } });
  const project = scenario === 'wrong project' ? 'pr-merge-orchestration' : dispatchProjectRef;
  const response = await main([rootDir, repo, String(prNumber), head, ownerKey,
    'false', '', '', project, epoch.id], { env: freshEnv(),
    ...(scenario.startsWith('bootstrap missing') && { prepareDispatchReadContextImpl: async () =>
      ({ ok: false, detail: 'bootstrap-credential-missing' }) }),
    ...(scenario === 'stale head' && { readLivePrImpl: async () => ({ prState: 'open', headSha: 'e'.repeat(40) }) }),
  });
  if (reason) {
    assert.equal(response.ok, false);
    assert.equal(response.reason, reason);
    assert.equal(response.detail, detail);
    if (detail) assert.deepEqual(response.scope, { appId: 'adversarial-review', repo, projectRef: dispatchProjectRef });
  } else {
    assert.deepEqual(response, { ok: true, replayed: true, protocol: 'retained-repair-replay-v1',
      epoch: before.repairEpochs[0] });
  }
  assert.deepEqual(readHammerRetryCapLedger(rootDir, identity), before);
});
