import { loadAwareTimeoutMs } from './load-aware-timeout.mjs';
// REMLABEL-01: reusable production check for merge callers that bypass review.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { execGhWithRetry } from './gh-cli.mjs';
import { evaluateLivePackCrossEdits, listPullRequestFiles } from './live-pack-cross-edit.mjs';
import { fetchRepoFileAtRef } from './pack-lockhash.mjs';
import { normalizeActorLogin } from './untrusted-pr-gate.mjs';

const execFileAsync = promisify(execFile);
const labelsOf = pr => (pr.labels || []).map(label => typeof label === 'string' ? label : label.name).sort();
const inputsOf = pr => JSON.stringify([pr.state, pr.head?.sha, pr.base?.sha, pr.head?.ref, pr.title, labelsOf(pr)]);

export async function checkLivePackMerge({ repo, prNumber, headSha, execFileImpl = execFileAsync,
  readPrImpl = async () => JSON.parse((await execGhWithRetry({ execFileImpl,
    args: ['api', `repos/${repo}/pulls/${prNumber}`], timeoutMs: loadAwareTimeoutMs(15_000) })).stdout),
  listFilesImpl = () => listPullRequestFiles(repo, prNumber, { execFileImpl }),
  fetchFileAtRefImpl = (repo, path, ref) => fetchRepoFileAtRef(repo, path, ref, { execFileImpl }),
  readActiveDagRunsImpl, trustedStampLoginsImpl,
} = {}) {
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo || '') || !Number.isSafeInteger(Number(prNumber)) || Number(prNumber) <= 0
    || !/^[a-f0-9]{40}$/i.test(headSha || '')) return { ok: false, reason: 'live-pack-invalid-identity' };
  try {
    const pr = await readPrImpl();
    if (pr.state !== 'open' || pr.head?.sha !== headSha || !pr.base?.sha) {
      return { ok: false, reason: 'live-pack-head-not-current' };
    }
    const result = await evaluateLivePackCrossEdits({ repo, prNumber, changedPaths: await listFilesImpl(),
      branch: pr.head.ref, title: pr.title, baseRef: pr.base.sha, headRef: headSha, labels: pr.labels,
      fetchFileAtRefImpl, readActiveDagRunsImpl, trustedStampLoginsImpl,
      resolvePrAuthorImpl: async () => normalizeActorLogin(pr.user?.login, { typename: pr.user?.type }) });
    if (inputsOf(await readPrImpl()) !== inputsOf(pr)) return { ok: false, reason: 'live-pack-inputs-changed' };
    const unreadablePlan = result.findings.find(finding => finding.read_outcome);
    return { ok: result.findings.length === 0,
      reason: unreadablePlan ? `live-pack-read-${unreadablePlan.read_outcome}:${unreadablePlan.plan_id}`
        : result.findings.length ? 'operator-label-required:live-pack-edit-approved' : 'live-pack-clear',
      headSha, findings: result.findings, waived: result.waived, exemptions: result.exemptions };
  } catch {
    return { ok: false, reason: 'live-pack-check-unreadable' };
  }
}
