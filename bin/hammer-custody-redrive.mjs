#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { completeDeferredSourceRedrive, recordDeferredSourceCandidate, recordDeferredSourceRefusal } from '../src/ama/deferred-source-custody.mjs';
import { CustodyReplayRefusal, readCustodyRedriveIntent, restoreCustodySource } from '../src/ama/custody-redrive.mjs';
import { hammerLocalGit, hammerNetworkCall } from '../src/ama/hammer-api-network.mjs';
import { readHammerSource } from '../src/ama/hammer-source-publication.mjs';

const env = process.env;
const git = (...args) => hammerLocalGit(['--no-replace-objects', ...args]).toString().trim();
const readSource = () => readHammerSource(env.HAM_REPO, env.HAM_PR_NUMBER);
let pending;
try {
  pending = readCustodyRedriveIntent(env);
  const { branch, previousHead, baseRef } = await readSource();
  const [action, expectedHead, receipt] = process.argv.slice(2);
  if (action === 'prepare') {
    if (previousHead !== env.HAM_TARGET_REMEDIATION_SHA) throw new Error('PR head moved');
    const base = `refs/heads/${baseRef}`;
    git('check-ref-format', base);
    const fetchObject = object => hammerNetworkCall('git', ['fetch', '--no-tags', '--no-recurse-submodules', 'origin', object]);
    await fetchObject(base);
    const baseHead = git('rev-parse', '--verify', 'FETCH_HEAD^{commit}');
    const head = await restoreCustodySource(pending, { liveHead: previousHead, baseHead, fetchObject });
    console.log(JSON.stringify({ head, branch, previousHead, baseHead }));
  } else if (action === 'validated') {
    const validation = JSON.parse(readFileSync(receipt, 'utf8'));
    if (previousHead !== env.HAM_TARGET_REMEDIATION_SHA || git('rev-parse', 'HEAD') !== expectedHead
      || git('status', '--porcelain') || validation.head !== expectedHead
      || !Array.isArray(validation.checks) || !validation.checks.length) throw new Error('custody validation receipt unavailable');
    if (validation.checks.some(check => check?.result === 'fail')) {
      throw new CustodyReplayRefusal('retained-source-failed-validation');
    }
    if (validation.status !== 0 || validation.validation === 'unknown'
      || validation.checks.some(check => !check || check.status === 'failed' || check.result === 'inconclusive')
      || !recordDeferredSourceCandidate(pending, expectedHead)) throw new Error('custody validation did not certify the candidate');
  } else if (action === 'complete') {
    if (expectedHead !== pending.source.redrive.candidate) throw new Error('custody publication is unconfirmed');
    let liveHead = previousHead;
    // After the push the PR API can briefly still report the source head.
    for (const waitMs of [500, 1000]) {
      if (liveHead === expectedHead || liveHead !== env.HAM_TARGET_REMEDIATION_SHA) break;
      await delay(waitMs);
      ({ previousHead: liveHead } = await readSource());
    }
    if (liveHead !== expectedHead) {
      console.error(`custody complete: live head ${liveHead} did not match candidate ${expectedHead}`);
      const reason = liveHead === env.HAM_TARGET_REMEDIATION_SHA
        ? 'PR API still reports the source head' : 'PR head diverged from the source and candidate';
      throw new Error(`custody publication is unconfirmed: ${reason}`);
    }
    if (!completeDeferredSourceRedrive(pending, liveHead)) {
      throw new Error(`custody publication is unconfirmed: candidate ${expectedHead} is live but custody settlement failed`);
    }
  } else throw new Error('unknown custody redrive action');
} catch (error) {
  if (error instanceof CustodyReplayRefusal) {
    try { recordDeferredSourceRefusal(pending, error.message); }
    catch { console.error('hammer custody retry: refusal could not be recorded'); }
  }
  // A failed git subprocess can carry repository contents in stderr.
  console.error(`hammer custody retry: ${error.status === undefined ? error.message : 'Git replay failed'}`);
  process.exitCode = 75;
}
