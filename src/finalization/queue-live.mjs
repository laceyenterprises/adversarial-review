import { resolveGateStatusContext } from '../adversarial-gate-context.mjs';
import { closerReviewProof } from '../ama/closer-review-proof.mjs';
import { checkCiCost } from '../ama/ci-cost.mjs';
import { createHistoryReader } from '../ama/history-reader.mjs';
import { fetchPrimaryChange } from '../ama/primary-change.mjs';
import { createReviewCurrencyReader } from '../ama/review-currency.mjs';
import { amaReviewerFamilyForLogin, latestAuthoritativeReviewInAncestry } from '../ama/reviewer-authority.mjs';
import { readHammerProvenanceComments } from '../ama/hammer-head-validation.mjs';
import { normalizeRequiredContexts } from '../branch-protection.mjs';
import { parseReviewFindings } from '../kernel/review-findings.mjs';
import { normalizeEffectiveReviewVerdict } from '../kernel/verdict.mjs';
import { isOperatorHeld } from '../operator-hold-labels.mjs';
import { handoffDigest } from './queue-handoff.mjs';
import { readQueueGitHubPages } from './queue-github.mjs';

const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const slug = value => typeof value === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) ? value.toLowerCase() : null;
const basePath = lane => `repos/${lane.repository}/branches/${encodeURIComponent(lane.base)}`;

// Resolve both classic branch protection and inherited repository/org rules.
// A 404 on a branch already observed protected is not an empty required set.
export async function readQueueBranchPolicy(read, lane) {
  const path = basePath(lane);
  const branch = await read(path);
  if (branch?.name !== lane.base || !sha(branch.commit?.sha) || typeof branch.protected !== 'boolean') throw new Error('queue-branch-unavailable');
  const sourceRef = `github:${path}`;
  const rules = await readQueueGitHubPages(read, `repos/${lane.repository}/rules/branches/${encodeURIComponent(lane.base)}`);
  const allowed = ['required_status_checks', 'non_fast_forward', 'update', 'deletion', 'creation', 'pull_request',
    'required_signatures', 'required_linear_history', 'merge_queue', 'required_deployments', 'code_scanning',
    'workflows', 'required_code_scanning', 'required_workflows', 'copilot_code_review', 'commit_message_pattern',
    'commit_author_email_pattern', 'committer_email_pattern', 'branch_name_pattern', 'tag_name_pattern'];
  if (rules.some(rule => !allowed.includes(rule?.type))) throw new Error('queue-branch-rules-unavailable');
  let classic = null;
  if (branch.protected) {
    try { classic = await read(`${path}/protection`); }
    catch (error) {
      // The branch endpoint explicitly reports whether classic protection has
      // required checks. Ruleset-only branches may have no classic protection.
      if (!/HTTP 404\b/.test(String(error.stderr || '')) || !rules.length
        || branch.protection?.enabled !== false) throw error;
    }
  }
  if (classic && typeof classic !== 'object') throw new Error('queue-branch-protection-unavailable');
  const legacy = classic?.required_status_checks ?? null;
  const ruleChecks = rules.filter(rule => rule.type === 'required_status_checks').map(rule => rule.parameters);
  if (ruleChecks.some(rule => !Array.isArray(rule?.required_status_checks))
    || (legacy && !Array.isArray(legacy.contexts) && !Array.isArray(legacy.checks))) throw new Error('required-set-unresolved');
  const contexts = [...normalizeRequiredContexts(classic),
    ...ruleChecks.flatMap(rule => rule.required_status_checks.map(check => check.context))];
  // These requirements cannot be projected as ordinary status contexts. A
  // separate GitHub merge queue would schedule a remote write outside our fence.
  if (rules.some(rule => ['merge_queue', 'workflows', 'required_workflows'].includes(rule.type))) {
    throw new Error('queue-branch-policy-unsupported');
  }
  const checkApps = [...(legacy?.checks ?? []).map(check => ({ context: check.context, appId: check.app_id })),
    ...ruleChecks.flatMap(rule => rule.required_status_checks.map(check => ({ context: check.context, appId: check.integration_id })))
  ].filter(check => check.appId != null && check.appId !== -1);
  return { complete: true, sourceRef, head: branch.commit.sha, contexts, checkApps,
    version: handoffDigest([legacy, rules]),
    canForcePush: (!branch.protected || classic?.allow_force_pushes?.enabled === true)
      && !rules.some(rule => ['non_fast_forward', 'update', 'required_signatures', 'pull_request'].includes(rule.type)),
    requiresUpToDateBranch: legacy?.strict === true || ruleChecks.some(rule => rule.strict_required_status_checks_policy === true),
  };
}

export function createQueueLiveReads({ rootDir, github, env = process.env, primaryChange = fetchPrimaryChange } = {}) {
  async function snapshot(lane, prNumber, budget) {
    if (!Number.isSafeInteger(prNumber) || prNumber <= 0) throw new Error('queue-pr-identity-unavailable');
    const repo = lane.repository;
    const get = github.reader(repo, budget);
    const path = `repos/${repo}/pulls/${prNumber}`;
    const pr = await get(path);
    if (pr?.number !== prNumber || slug(pr.base?.repo?.full_name) !== repo || pr.base?.ref !== lane.base
      || !['open', 'closed'].includes(pr.state) || !sha(pr.head?.sha)) throw new Error('queue-pr-identity-moved');
    const state = pr.merged === true || pr.merged_at ? 'merged' : pr.state;
    // Pull-list summaries do not prove label completeness. A hold on a later
    // label page must fence the same mutation as a hold on the first page.
    const labels = state === 'open' ? await readQueueGitHubPages(get, `repos/${repo}/issues/${prNumber}/labels`) : null;
    const subject = { lane, prNumber, state, head: pr.head.sha,
      baseSha: pr.base.sha ?? null, headRepository: slug(pr.head.repo?.full_name), headRef: pr.head.ref ?? null,
      labels, sourceRef: `github:${path}`, mergeCommitSha: pr.merge_commit_sha ?? null,
      mergedAt: pr.merged_at ?? null, mergedBy: pr.merged_by?.login ?? null };
    if (subject.state === 'merged' && (!sha(subject.mergeCommitSha) || !Number.isFinite(Date.parse(subject.mergedAt)) || !subject.mergedBy)) {
      throw new Error('queue-merge-readback-incomplete');
    }
    return { pr, get, subject, path };
  }
  async function reviews(context, throughHead = context.subject.head) {
    const { get, path, subject } = context;
    const { repository: repo } = subject.lane;
    const comments = await readHammerProvenanceComments(page => get(`repos/${repo}/issues/${subject.prNumber}/comments?per_page=100&page=${page}`));
    if (!Array.isArray(comments)) throw new Error('queue-comment-history-incomplete');
    const reviews = await readQueueGitHubPages(get, `${path}/reviews`);
    const currency = createReviewCurrencyReader({ repo, prNumber: subject.prNumber, rootDir, get, comments });
    const compare = (from, to) => get(`repos/${repo}/compare/${from}...${to}`);
    const families = new Map();
    for (const review of reviews) {
      const family = amaReviewerFamilyForLogin(review.user?.login);
      if (family) families.set(family, [...(families.get(family) ?? []), review]);
    }
    const applicable = [];
    for (const [family, rows] of families) {
      const row = await latestAuthoritativeReviewInAncestry(rows, throughHead, compare, currency);
      if (!row) continue;
      if (!Number.isSafeInteger(row.id) || !Number.isFinite(Date.parse(row.submitted_at))) throw new Error('queue-review-binding-unavailable');
      const parsed = parseReviewFindings(row.body);
      const verdict = normalizeEffectiveReviewVerdict(row.body);
      if (parsed.findingsCount === null || !verdict) throw new Error('queue-review-inventory-unavailable');
      const sourceRef = `github:${path}/reviews/${row.id}`;
      const proof = { ...await currency(row.commit_id, throughHead), sourceRef };
      const findings = [['blocking', parsed.blocking.findings], ['non-blocking', parsed.nonBlocking.findings]]
        .flatMap(([severity, findings]) => findings.map(finding => ({ ...finding,
          findingId: handoffDigest([finding.title, finding.file, finding.lines ?? null]), reviewId: String(row.id),
          reviewCommitId: row.commit_id, severity, sourceRef, currency: proof })));
      applicable.push({ row, family, sourceRef, currency: proof, findings, verdict });
    }
    const snapshot = { state: subject.state, headSha: subject.head, reviews, comments };
    return { comments, applicable: applicable.sort((a, b) => b.row.id - a.row.id), snapshot };
  }
  async function primary(context, budget, builderHead) {
    const { subject } = context;
    const { repository: repo } = subject.lane;
    const get = createHistoryReader({ env, signal: budget.signal, contextTimeoutMs: budget.timeoutMs,
      execGhWithRetryImpl: async ({ args, timeoutMs, totalTimeoutMs, signal }) => github.get(repo,
        args.slice(1), { timeoutMs: Math.min(budget.timeoutMs, timeoutMs, totalTimeoutMs), signal }) });
    return primaryChange({ repo, prNumber: subject.prNumber, headSha: subject.head, rootDir,
      get, builderHead, signal: budget.signal }, { contextTimeoutMs: budget.timeoutMs });
  }
  return { snapshot, reviews, primary, policyAdapter: { read: ({ entry, ...budget }) =>
    readQueueBranchPolicy(github.reader(entry.lane.repository, budget), entry.lane) },
  liveAdapter: (cfg, readReceipt) => ({ async read({ entry, kind, ...budget }) {
    const observed = await snapshot(entry.lane, entry.prNumber, budget);
    const { subject, get, pr } = observed;
    if (subject.state !== 'open' || kind === 'merge-reconcile') return { subject };
    const policy = await readQueueBranchPolicy(get, entry.lane);
    subject.baseSha = policy.head;
    // Check polling only needs authoritative lifecycle and exact candidate/base.
    if (!kind) return { subject };
    const rawLabels = subject.labels;
    if (!Array.isArray(rawLabels) || isOperatorHeld(rawLabels) || ![entry.head, entry.expectedOldHead, entry.candidate].includes(subject.head)) return { subject };
    const repo = entry.lane.repository;
    const sourceRef = `github:repos/${repo}`;
    const credential = await github.credential(repo, budget.timeoutMs, budget.signal);
    const identity = await github.identity(repo, budget);
    const repoDetails = await get(`repos/${repo}`);
    if (slug(repoDetails.full_name) !== repo || typeof repoDetails.archived !== 'boolean') throw new Error('queue-repo-permission-unavailable');
    const fork = subject.headRepository !== repo;
    const headPolicy = fork || !subject.headRef ? null : await readQueueBranchPolicy(get, { repository: repo, base: subject.headRef });
    const canPush = !repoDetails.archived && credential.permissions?.contents === 'write' && repoDetails.permissions?.push !== false;
    const receipt = readReceipt?.(entry);
    const checkedAt = receipt?.evidence?.reviewProof?.observedAt ?? entry.acknowledgedAt;
    const current = await reviews(observed);
    const proof = await closerReviewProof({ snapshot: current.snapshot, repo, prNumber: entry.prNumber, rootDir,
      headSha: subject.head, validatedAt: checkedAt, operatorLogins: cfg.operatorLogins, get });
    const original = receipt?.input ?? receipt?.handoff;
    // After a mechanical rewrite, the source review can be divergent from the
    // candidate. The original inventory must still exist and remain current at
    // its admitted head. Candidate applicability is checked separately above.
    if (proof.ok && original && subject.head !== original.head) {
      const atAdmission = await reviews(observed, original.head);
      const expected = receipt.evidence.review.findings.map(f => f.findingId).sort();
      const found = atAdmission.applicable.flatMap(r => r.findings.map(f => f.findingId)).sort();
      if (JSON.stringify(expected) !== JSON.stringify(found) || !atAdmission.applicable.some(r => String(r.row.id) === original.sourceReview.id)) {
        Object.assign(proof, { ok: false, reason: 'review-changed-since-validation' });
      }
    }
    if (proof.ok && ['final-merge', 'merge-preflight'].includes(kind) && pr.mergeable_state === 'blocked') {
      Object.assign(proof, { ok: false, reason: 'branch-rule-blocked' });
    }
    const primaryChange = await primary(observed, budget, receipt?.evidence?.builderAttestation?.record?.head_sha);
    const cost = checkCiCost(primaryChange.ciCost, subject.head);
    const source = current.applicable[0];
    const findings = current.applicable.flatMap(review => review.findings);
    return { subject, identity, structuralSourceRef: policy.sourceRef,
      currentReview: source ? { complete: true, id: String(source.row.id), commitId: source.row.commit_id,
        sourceRef: source.sourceRef, findings, verdict: cleanReview(source) ? 'settled-success' : source.verdict } : null,
      permission: { sourceRef, rulesSourceRef: headPolicy?.sourceRef ?? policy.sourceRef,
        canPush, canForcePush: headPolicy?.canForcePush === true, fork, canWriteHeadRepository: !fork && canPush,
        maintainerCanModify: pr.maintainer_can_modify === true, headRepository: subject.headRepository, headRef: subject.headRef },
      eligibility: { mergeable: pr.draft ? 'CONFLICTING' : pr.mergeable === true ? 'MERGEABLE' : pr.mergeable === false ? 'CONFLICTING' : 'UNKNOWN',
        mergeStateStatus: String(pr.mergeable_state ?? '').toUpperCase(), requiredChecks: false,
        branchProtectionRequired: cfg.branchProtection?.required, requiredGateContext: resolveGateStatusContext(env),
        branchProtectionRequiredContexts: policy.contexts, requiresUpToDateBranch: policy.requiresUpToDateBranch,
        strictNonBlockingRemediation: cfg.strictNonBlockingRemediation, primaryChange,
        terminalReviewProof: proof.ok && !cost.ok ? cost : proof },
    };
  } }) };
}

export function cleanReview(review) {
  return ['approved', 'comment-only'].includes(review?.verdict) && !review.findings.length
    && review.row.state !== 'DISMISSED' && review.row.state !== 'CHANGES_REQUESTED';
}
