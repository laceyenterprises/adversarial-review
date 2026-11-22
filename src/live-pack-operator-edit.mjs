// LIVEPACKHANDOFF-01: closure credit for a finding whose fix lies in a live
// build pack's protected files comes only from an operator's published edit,
// proven at the exact live PR head. Worker text (pushback, Resolved-By-Policy,
// "no human input") and the approval label alone prove nothing: the label is
// operator approval of a source change, never a worker write grant.
//
// Evidence, all read from GitHub for one PR head:
// - the PR is open and its head moved past the cited reviewed head, which is
//   an ancestor of it (compare status `ahead`, complete commit and file lists);
// - every protected path changed in reviewed..head, and each commit in that
//   range touching it carries no worker provenance trailer;
// - `live-pack-edit-approved` is present and was last labeled by a configured
//   operator login;
// - the head and labels are unchanged when the read finishes.
// Any failed, truncated or ambiguous read leaves the finding operator-owned.
import { LIVE_PACK_EDIT_WAIVER_LABEL } from './live-pack-cross-edit.mjs';
import { normalizeActorLogin } from './untrusted-pr-gate.mjs';

const SHA_RE = /^[a-f0-9]{40}$/i;
// Builders, remediators and hammers all commit through the worker-provenance
// hook; a protected-path commit carrying any of these is worker-authored.
const WORKER_PROVENANCE_RE = /^(?:Worker-Class|Worker-Job-Id|Worker-Ticket|Closed-By)[ \t]*:/im;
const COMPARE_COMMIT_LIMIT = 250;
const COMPARE_FILE_LIMIT = 300;
const PAGE_SIZE = 100;
const TIMELINE_PAGE_LIMIT = 30;

const labelNames = pr => (pr?.labels || []).map(label => (typeof label === 'string' ? label : label?.name)).filter(Boolean).sort();

async function timelineEvents(get, repo, prNumber) {
  const events = [];
  for (let page = 1; page <= TIMELINE_PAGE_LIMIT; page += 1) {
    const batch = await get(`repos/${repo}/issues/${prNumber}/timeline?per_page=${PAGE_SIZE}&page=${page}`);
    if (!Array.isArray(batch)) throw new Error('timeline page is not an array');
    events.push(...batch);
    if (batch.length < PAGE_SIZE) return events;
  }
  throw new Error('timeline exceeds the read limit');
}

function operatorApprovedLabel(events, operators) {
  const latest = events.filter(event => ['labeled', 'unlabeled'].includes(event?.event)
    && event?.label?.name === LIVE_PACK_EDIT_WAIVER_LABEL).at(-1);
  if (latest?.event !== 'labeled') return null;
  const actor = normalizeActorLogin(latest.actor?.login, { typename: latest.actor?.type });
  return actor && operators.has(actor) ? { actor, createdAt: latest.created_at || null } : null;
}

export async function readOperatorLivePackEditEvidence({ repo, prNumber, reviewedSha, paths = [], operatorLogins = [], get }) {
  const fail = reason => ({ ok: false, reason });
  try {
    const wanted = [...new Set(paths)].sort();
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '') || !/^[1-9]\d*$/.test(String(prNumber || ''))
      || typeof get !== 'function' || !wanted.length) return fail('evidence-input-invalid');
    if (!SHA_RE.test(reviewedSha || '')) return fail('reviewed-head-unknown');
    const operators = new Set(operatorLogins.map(login => normalizeActorLogin(login)).filter(Boolean));
    if (!operators.size) return fail('operator-logins-unconfigured');
    const pr = await get(`repos/${repo}/pulls/${prNumber}`);
    const headSha = pr?.head?.sha;
    if (pr?.state !== 'open' || !SHA_RE.test(headSha || '')) return fail('pr-head-unreadable');
    if (headSha.toLowerCase() === reviewedSha.toLowerCase()) return fail('head-not-moved-since-review');
    if (!labelNames(pr).includes(LIVE_PACK_EDIT_WAIVER_LABEL)) return fail('operator-approval-label-absent');
    const approval = operatorApprovedLabel(await timelineEvents(get, repo, prNumber), operators);
    if (!approval) return fail('operator-approval-label-unproven');
    const compare = await get(`repos/${repo}/compare/${reviewedSha}...${headSha}`);
    if (compare?.status !== 'ahead') return fail('head-not-descendant-of-reviewed-head');
    const commits = Array.isArray(compare.commits) ? compare.commits : null;
    const files = Array.isArray(compare.files) ? compare.files : null;
    if (!commits || !files || commits.length !== compare.total_commits || commits.length > COMPARE_COMMIT_LIMIT
      || files.length >= COMPARE_FILE_LIMIT) return fail('compare-truncated');
    const rangeShas = new Set(commits.map(commit => String(commit?.sha || '').toLowerCase()));
    const proven = {};
    const refused = {};
    for (const path of wanted) {
      if (!files.some(file => file?.filename === path || file?.previous_filename === path)) {
        refused[path] = 'protected-path-unchanged';
        continue;
      }
      const history = await get(`repos/${repo}/commits?sha=${headSha}&path=${encodeURIComponent(path)}&per_page=${PAGE_SIZE}`);
      if (!Array.isArray(history) || history.length >= PAGE_SIZE) {
        refused[path] = 'path-history-truncated';
        continue;
      }
      const inRange = history.filter(commit => rangeShas.has(String(commit?.sha || '').toLowerCase()));
      if (!inRange.length) refused[path] = 'protected-path-unchanged';
      else if (inRange.some(commit => WORKER_PROVENANCE_RE.test(String(commit?.commit?.message || '')))) {
        refused[path] = 'worker-authored-protected-edit';
      } else proven[path] = { commits: inRange.map(commit => commit.sha) };
    }
    const final = await get(`repos/${repo}/pulls/${prNumber}`);
    if (final?.state !== 'open' || final?.head?.sha !== headSha
      || JSON.stringify(labelNames(final)) !== JSON.stringify(labelNames(pr))) return fail('pr-changed-during-read');
    return { ok: true, headSha, reviewedSha, approval, paths: proven, refused };
  } catch (error) {
    return fail(`evidence-read-failed: ${String(error?.message || error).slice(0, 200)}`);
  }
}

// Move each operator-owned finding whose every protected path is proven into
// `resolved` with its exact-head evidence. Everything else stays operator-owned.
export function applyOperatorLivePackEdits(policy, evidence) {
  if (!policy || !Array.isArray(policy.operatorOwned) || !evidence?.ok) return policy;
  const verified = [];
  const operatorOwned = [];
  for (const finding of policy.operatorOwned) {
    const paths = finding.livePackPaths || [];
    if (!paths.length || !paths.every(path => evidence.paths?.[path])) {
      operatorOwned.push(finding);
      continue;
    }
    const { handoffLines, ...rest } = finding;
    void handoffLines;
    verified.push({ ...rest, addressed: !finding.mixed,
      operatorEdit: { headSha: evidence.headSha, reviewedSha: evidence.reviewedSha, approvedBy: evidence.approval.actor,
        paths, commits: [...new Set(paths.flatMap(path => evidence.paths[path].commits))] },
      auditLines: paths.map(path => `Operator-Edit-Verified: live-pack-plan ${path} at ${evidence.headSha}`) });
  }
  if (!verified.length) return policy;
  const bullets = verified.filter(finding => !finding.mixed).map(finding => `- **${finding.title}** (${finding.blocking ? 'blocking' : 'non-blocking'}) — `
    + `verified operator edit of ${finding.livePackPaths.join(', ')} at exact head ${evidence.headSha} after reviewed head ${evidence.reviewedSha}.`);
  const lines = [...new Set(verified.flatMap(finding => finding.auditLines))];
  return { ...policy, resolved: [...policy.resolved, ...verified.filter(finding => !finding.mixed)], operatorOwned,
    operatorHandoff: [...new Set(operatorOwned.flatMap(finding => finding.handoffLines))].join('\n'),
    auditDetails: [policy.auditDetails, ...bullets, ...lines].filter(Boolean).join('\n') };
}
