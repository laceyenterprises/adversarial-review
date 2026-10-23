import { loadAwareTimeoutMs } from './load-aware-timeout.mjs';
// REST equivalent of the hammer's PR/head/check reads. Keep the shared check
// classifier in charge; retain run timestamps and pending latest-run status.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { meteredExecFile } from './metered-gh.mjs';

async function fetchHammerPr(repo, prNumber, { withChecks = true, withReviews = false, read = null } = {}) {
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo) || !/^[1-9]\d*$/.test(String(prNumber))) {
    throw new TypeError('Invalid GitHub PR reference');
  }
  const get = read || (async path => {
    const { stdout } = await meteredExecFile(promisify(execFile), 'gh', ['api', path], { hammerToken: true, timeout: loadAwareTimeoutMs(30_000), killSignal: 'SIGKILL', maxBuffer: 10 * 1024 * 1024, env: process.env });
    return JSON.parse(stdout);
  });
  const pr = await get(`repos/${repo}/pulls/${prNumber}`);
  const snapshot = {
    id: pr.node_id, number: pr.number, title: pr.title, body: pr.body,
    state: pr.merged_at ? 'MERGED' : String(pr.state || '').toUpperCase(),
    mergedAt: pr.merged_at, closedAt: pr.closed_at, isDraft: pr.draft,
    headRefOid: pr.head?.sha, headSha: pr.head?.sha, headRefName: pr.head?.ref,
    baseRefName: pr.base?.ref, author: pr.user,
    mergeable: pr.mergeable === true ? 'MERGEABLE' : pr.mergeable === false ? 'CONFLICTING' : 'UNKNOWN',
    mergeStateStatus: String(pr.mergeable_state || '').toUpperCase(),
    labels: Array.isArray(pr.labels) ? pr.labels.map(label => ({ id: label.node_id, name: label.name, color: label.color })) : null,
    mergeCommit: pr.merged_at && pr.merge_commit_sha ? { oid: pr.merge_commit_sha } : null,
  };
  if (withChecks && snapshot.headRefOid) {
    const checks = [];
    for (const kind of ['check-runs', 'statuses']) {
      for (let page = 1; ; page += 1) {
        const payload = await get(`repos/${repo}/commits/${snapshot.headRefOid}/${kind}?per_page=100&page=${page}${kind === 'check-runs' ? '&filter=all' : ''}`);
        const rows = kind === 'check-runs' ? payload.check_runs : payload;
        if (!Array.isArray(rows)) throw new Error('Invalid check response');
        checks.push(...rows.map(item => kind === 'check-runs' ? {
          __typename: 'CheckRun', name: item.name, status: item.status ? String(item.status).toUpperCase() : null,
          conclusion: item.conclusion ? String(item.conclusion).toUpperCase() : null, detailsUrl: item.details_url,
          createdAt: item.created_at, startedAt: item.started_at, completedAt: item.completed_at,
        } : {
          __typename: 'StatusContext', context: item.context, state: item.state ? String(item.state).toUpperCase() : null,
          createdAt: item.created_at, updatedAt: item.updated_at,
        }));
        if (rows.length < 100) break;
      }
    }
    snapshot.statusCheckRollup = checks;
    snapshot.checks = checks;
  }
  if (withReviews) {
    snapshot.reviews = [];
    for (let page = 1; ; page++) {
      const reviews = await get(`repos/${repo}/pulls/${prNumber}/reviews?per_page=100&page=${page}`);
      if (!Array.isArray(reviews)) throw new Error('Invalid review response');
      snapshot.reviews.push(...reviews.map(review => ({ ...review,
        author: review.user, submittedAt: review.submitted_at, commit: { oid: review.commit_id },
      })));
      if (reviews.length < 100) break;
    }
  }
  return snapshot;
}

export { fetchHammerPr };
