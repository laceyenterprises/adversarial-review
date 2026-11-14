import { readDaemonBuildIdentity } from './daemon-worker-identity.mjs';
import { readDispatchLaunches, readWorkerObservation, prepareDispatchReadContext } from './dispatch-read-client.mjs';
import { isCrossModelReviewWaived, normalizeBuilderClass, normalizeReviewerModel } from './adapters/subject/github-pr/routing.mjs';
import Database from 'better-sqlite3';
import { join } from 'node:path';

const PREFIX = 'tenure-independent-review:';
const SHA = '[a-f0-9]{40}';

// Read the stable PR opener, not the most recent remediation completion.
// Missing fields on older launch producers mean untenured. Transport failures
// are not evidence of an absent tenure.
export async function readPrTenure({ repo, prNumber, env = process.env,
  readBuildIdentityImpl = readDaemonBuildIdentity, readLaunchesImpl = readDispatchLaunches,
  headSha = null, readHeadProvenanceImpl = readWorkerObservation,
  ...options } = {}) {
  if (readBuildIdentityImpl === readDaemonBuildIdentity
    && env.ADVERSARIAL_DISPATCH_READS_ENABLED !== '1'
    && env.ADVERSARIAL_WORKER_OBSERVATIONS_ENABLED !== '1') return null;
  if (readLaunchesImpl === readDispatchLaunches && env.ADVERSARIAL_DISPATCH_READS_ENABLED !== '1') {
    const ready = await prepareDispatchReadContext({ ...options, env });
    if (!ready.ok) throw new Error('tenure-dispatch-context-unavailable');
  }
  const identity = await readBuildIdentityImpl({ ...options, repo, prNumber, env });
  if (!identity?.ok) {
    if (['unconfirmed-pr-opener-provenance', 'worker-observation-inconclusive'].includes(identity?.reason)) return null;
    throw new Error('tenure-build-identity-unavailable');
  }
  const opener = identity.rows?.[0];
  if (!opener?.launch_request_id) throw new Error('tenure-build-launch-missing');
  const launches = await readLaunchesImpl({ launch_request_ids: [opener.launch_request_id] },
    { ...options, env });
  const launch = launches?.ok && launches.rows?.find(row => row.launch_request_id === opener.launch_request_id);
  if (!launch) throw new Error('tenure-build-launch-unavailable');
  if (typeof launch.tenureId !== 'string' || !launch.tenureId.trim()) return null;
  const tenure = { tenureId: launch.tenureId, workerClass: launch.worker_class || opener.worker_class,
    launchRequestId: opener.launch_request_id };
  if (headSha) {
    const producer = await readHeadProvenanceImpl({ observation: 'provenance', repo,
      pr_number: Number(prNumber), head_sha: headSha, builder_identity: true, limit: 100 }, { ...options, env });
    if (!producer?.ok && producer?.reason !== 'worker-observation-inconclusive') {
      throw new Error('tenure-head-provenance-unavailable');
    }
    const completion = producer?.ok && producer.rows?.[0];
    if (completion && completion.head_sha !== headSha) throw new Error('tenure-head-provenance-mismatch');
    if (completion?.head_sha === headSha && completion.launch_request_id !== opener.launch_request_id) {
      const stages = await readLaunchesImpl({ launch_request_ids: [completion.launch_request_id] }, { ...options, env });
      const stage = stages?.ok && stages.rows?.find(row => row.launch_request_id === completion.launch_request_id);
      if (!stage) throw new Error('tenure-stage-launch-unavailable');
      if (stage.tenureId === tenure.tenureId) tenure.remediationWorkerClass = stage.worker_class || completion.worker_class;
    }
  }
  return tenure;
}

export function tenureReviewReason(previousHead, headSha) {
  if (!new RegExp(`^${SHA}$`, 'i').test(previousHead || '')
    || !new RegExp(`^${SHA}$`, 'i').test(headSha || '') || previousHead === headSha) return null;
  return `${PREFIX} ${previousHead}..${headSha}`;
}

export function tenureHeadNeedsReview(required, reviewedHead, currentHead) {
  return Boolean(required && reviewedHead && currentHead && reviewedHead !== currentHead);
}

export function tenureReviewRange(reason, headSha) {
  const match = String(reason || '').match(new RegExp(`^${PREFIX} (${SHA})\\.\\.(${SHA})$`, 'i'));
  return match && match[2] === headSha ? { previousHead: match[1], headSha: match[2] } : null;
}

export function tenureReviewerAllowed(tenure, reviewerModel) {
  // Reuse the reviews-next-round harness-family predicate, including aliases.
  const classes = [tenure?.workerClass,
    ...(Object.hasOwn(tenure || {}, 'remediationWorkerClass') ? [tenure.remediationWorkerClass] : [])];
  return Boolean(normalizeReviewerModel(reviewerModel)
    && classes.every(workerClass => normalizeBuilderClass(workerClass)
      && !isCrossModelReviewWaived(workerClass, reviewerModel)));
}

export function formatTenureReviewRange(range) {
  return range ? `\nIndependent tenure remediation review. Review the exact head ${range.headSha}.\n`
    + `Remediation range: ${range.previousHead}..${range.headSha}\n`
    + 'Inspect the remediation and its effect on the full PR; earlier stage notes and hammer validation do not replace this review.\n' : '';
}

export function readTenureReviewRange({ rootDir, repo, prNumber, headSha }) {
  let db;
  try {
    db = new Database(join(rootDir, 'data', 'reviews.db'), { readonly: true, fileMustExist: true });
    const row = db.prepare('SELECT rereview_reason FROM reviewed_prs WHERE repo = ? AND pr_number = ?')
      .get(repo, prNumber);
    return tenureReviewRange(row?.rereview_reason, headSha);
  } catch (error) {
    if (error.code === 'SQLITE_CANTOPEN' || error.code === 'ENOENT'
      || (error.code === 'SQLITE_ERROR' && error.message === 'no such table: reviewed_prs')) return null;
    throw error;
  } finally { db?.close(); }
}

export function queueTenureReview({ db, request, repo, prNumber, previousHead, headSha }) {
  const reason = tenureReviewReason(previousHead, headSha);
  if (!reason) return null;
  if (!db.inTransaction) return db.transaction(() =>
    queueTenureReview({ db, request, repo, prNumber, previousHead, headSha })).immediate();
  const current = db.prepare('SELECT * FROM reviewed_prs WHERE repo = ? AND pr_number = ?').get(repo, prNumber);
  if (current?.review_status === 'posted' && current.reviewer_head_sha === headSha) {
    return { triggered: false, reason: 'exact-head-already-reviewed', reviewRow: current };
  }
  const result = request({ repo, prNumber, targetRevisionRef: headSha, reason,
    preserveBudgets: true, inTransaction: true });
  // A pending row is already armed. Attach the range without resetting its
  // attempts, changing its head, or racing the reviewer's single-claim CAS.
  db.prepare(`UPDATE reviewed_prs SET rereview_reason = ?
    WHERE repo = ? AND pr_number = ? AND pr_state = 'open'
      AND review_status = 'pending' AND revision_ref = ?`)
    .run(reason, repo, prNumber, headSha);
  return result;
}
