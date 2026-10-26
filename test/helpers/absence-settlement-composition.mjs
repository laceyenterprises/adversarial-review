// LAC-2120 offline companion harness. The producer starts authenticated HTTP;
// this side knows only a public packaged SDK and the native recovery entrypoint.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as installedSdk from '@agent-os/app-sdk';
import { main as settle } from '../../bin/settle-legacy-closer-intent.mjs';
import { reconcilePreReceiptIntent } from '../../src/ama/pre-receipt-intent.mjs';
import { updateAmaCloserDispatchRecord, readAmaCloserDispatchRecord, amaCloserDispatchFilePath } from '../../src/ama/dispatch-closer.mjs';
import { acquireAmaCloserLease, readAmaCloserLease, updateAmaCloserLease } from '../../src/ama/closer-lease.mjs';
import { readHammerRetryCapLedger } from '../../src/ama/hammer-retry-cap.mjs';

const input = JSON.parse(process.argv[2]);
const { scenario, root } = input;
mkdirSync(root, { recursive: true });
const identity = { repo: 'example/repo', prNumber: 8, headSha: 'a'.repeat(40) };
const started = '2026-01-01T00:00:00.000Z';
const expired = '2026-01-01T01:00:00.000Z';
const key = 'ama-closer-synthetic';
const record = { ...identity, schemaVersion: 1, workerClass: 'hammer',
  reviewedSha: identity.headSha, targetRemediationSha: identity.headSha,
  dispatchPhase: 'submitting', state: 'dispatching', dispatchIdempotencyKey: key,
  dispatchWatcher: { pid: 424242, startedAt: started },
  dispatchSubmitter: { pid: 424243, startedAt: started },
  lastAttemptedAt: started, dispatchTimeoutMs: 120000, retryCount: 2 };
updateAmaCloserDispatchRecord(root, identity, () => record);
acquireAmaCloserLease({ rootDir: root, ...identity, watcherPid: 424242, now: started });
const read = () => readAmaCloserDispatchRecord(root, identity);
const lease = () => readAmaCloserLease(root, identity);
const sdk = input.sdk_entry ? await import(input.sdk_entry) : installedSdk;
let calls = 0;
const dispatchSession = { dispatchLookup: async selector => {
  const result = await sdk.readSessionDispatchLookup(selector, input);
  if (++calls === 1 && ['receipt-race', 'replacement-race'].includes(scenario)) {
    // Simulate an independent writer while the observer yields; existing full
    // snapshot comparison must preserve it. No production record is involved.
    const next = scenario === 'receipt-race'
      ? { ...read(), launchRequestId: 'lrq_concurrent', state: 'dispatched' }
      : { ...read(), dispatchIdempotencyKey: 'replacement', retryCount: 7 };
    writeFileSync(amaCloserDispatchFilePath(root, identity), JSON.stringify(next));
  }
  return result;
} };
const options = { now: expired, dispatchSession,
  readPullRequestStateImpl: async () => ({ state: 'OPEN' }),
  processKillImpl: () => { throw Object.assign(Error('synthetic missing PID'), { code: 'ESRCH' }); },
  processExecFileSyncImpl: () => '515151 Thu Jan  1 00:00:00 2026 synthetic\n',
  deliverAlertImpl: async () => {}, print() {}, logger: { warn() {} } };
const args = ['--root-dir', root, '--hq-root', root, '--repo', identity.repo,
  '--pr', '8', '--head', identity.headSha];
if (['live', 'reused'].includes(scenario)) {
  options.now = '2026-01-01T00:00:30.000Z';
  options.processKillImpl = () => {};
  options.processExecFileSyncImpl = () =>
    `424242 Thu Jan  1 00:00:${scenario === 'live' ? '00' : '01'} 2026 unrelated\n`
    + `424243 Thu Jan  1 00:00:${scenario === 'live' ? '00' : '01'} 2026 unrelated\n`;
  const result = await reconcilePreReceiptIntent(root, identity, options);
  assert.equal(result.status, scenario === 'live' ? 'unknown' : 'no-launch');
  assert.equal(read().retryCount, scenario === 'live' ? 2 : 1);
} else if (scenario === 'existing') {
  await assert.rejects(settle([...args, '--apply', '--reason', 'synthetic recovery'], options), /closer-receipt-exists/);
  assert.equal(read().state, 'dispatching');
  const result = await reconcilePreReceiptIntent(root, identity, options);
  assert.equal(result.status, 'receipt-recovered');
  assert.equal(read().launchRequestId, 'lrq_matching');
  assert.equal(lease().lrqId, 'lrq_matching');
  assert.equal(readHammerRetryCapLedger(root, identity).lifetimeAttemptCount, 1);
} else if (['absent', 'refund-replay'].includes(scenario)) {
  const before = readFileSync(amaCloserDispatchFilePath(root, identity), 'utf8');
  const leaseBefore = lease();
  assert.equal((await settle(args, options)).conclusive, true);
  assert.equal(readFileSync(amaCloserDispatchFilePath(root, identity), 'utf8'), before);
  assert.deepEqual(lease(), leaseBefore);
  if (scenario === 'refund-replay') {
    // Replay the existing crash window after lease deferral, before intent write.
    updateAmaCloserLease({ rootDir: root, ...identity, status: 'terminal', terminalOutcome: 'deferred', now: expired });
  }
  const result = await settle([...args, '--apply', '--reason', 'synthetic recovery'], options);
  assert.equal(result.conclusive, true);
  assert.equal(read().reason, 'closer-ticket-no-launch-proven');
  assert.equal(read().retryCount, 1);
  assert.equal(lease().terminalOutcome, 'deferred');
  assert.equal(readHammerRetryCapLedger(root, identity), null);
  const proof = read().preReceiptReconciliation.query;
  assert.equal(proof.absenceProof.grant_id, 'incident-synthetic-attempt');
  assert.equal(proof.ticketQuery.absenceProof.selector.ticket_ref, 'AMA-PR-8');
  const audit = readFileSync(result.auditPath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(audit.map(row => row.outcome), ['settlement-authorized', 'settled-no-dispatch']);
  assert.equal(audit[0].evidence.absenceProof.grant_id, 'incident-synthetic-attempt');
  await assert.rejects(settle([...args, '--apply', '--reason', 'replay'], options));
  assert.equal(read().retryCount, 1);
} else {
  await assert.rejects(settle([...args, '--apply', '--reason', 'synthetic recovery'], options));
  assert.equal(read().retryCount, scenario === 'replacement-race' ? 7 : 2);
  assert.equal(lease().status, 'pending');
  assert.equal(read().state, scenario === 'receipt-race' ? 'dispatched' : 'dispatching');
}
const require = createRequire(import.meta.url);
const sdkEntry = input.sdk_entry ? new URL(input.sdk_entry).pathname : require.resolve('@agent-os/app-sdk');
console.log(JSON.stringify({ scenario, calls, sdkVersion: JSON.parse(readFileSync(join(sdkEntry, '../../package.json'))).version }));
