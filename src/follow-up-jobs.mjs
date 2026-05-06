import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { writeFileAtomic } from './atomic-write.mjs';

const MAX_CREATE_ATTEMPTS = 100;

const FOLLOW_UP_JOB_SCHEMA_VERSION = 2;
// Bounded remediation cap. This was uniformly 6 in PR #18's era,
// dropped to a uniform 3 after observing diminishing returns past
// round 3, then became risk-tiered. Post-2026-05-06 defaults are
// low=1, medium=2, high=3, critical=4. Pairs with a lenient final-round
// verdict threshold in the
// reviewer prompt (the final-round review only blocks on data
// corruption / secret leakage / security regression / broken
// external contract; everything else becomes a non-blocking note for
// human review). See prompts/reviewer-prompt-final-round-addendum.md.
//
// Legacy jobs persisted with the old 3- or 6-round caps keep their
// persisted value via the per-job `remediationPlan.maxRounds` field;
// only NEW jobs derive their budget from this table.
const LEGACY_DEFAULT_MAX_REMEDIATION_ROUNDS = 6;
const DEFAULT_RISK_CLASS = 'medium';
// Convergence loop budgets, post-2026-05-06:
// Higher-risk PRs get more bot rounds before operator escalation,
// because that's where you most want the bot to converge before
// pulling the operator in. Default (medium) = 2: the initial
// remediation triggered by the first `Request changes`, plus one
// auto-queued follow-up if the rereview is still `Request changes`.
// Below that, low = 1 (simpler PRs aren't worth multiple rounds).
// Above that, high = 3 and critical = 4 (more iterations to absorb
// tougher reviewer feedback before halting).
//
// Each round is one remediation + one rereview. After the cap is
// consumed, `claimNextFollowUpJob` refuses to start another round —
// the PR halts and waits for operator review (or the
// `operator-approved` label). The watcher ALWAYS fires the rereview
// after each remediation regardless of how close to the cap we are;
// the cap lives entirely on the remediation-enqueue side.
//
// Operator override (`operator-approved` label) is the escape valve
// when the operator has decided substance is fine despite a
// `Request changes` verdict, after the durable remediation ledger is
// otherwise merge-ready.
const ROUND_BUDGET_BY_RISK_CLASS = Object.freeze({
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
});
const DEFAULT_MAX_REMEDIATION_ROUNDS = ROUND_BUDGET_BY_RISK_CLASS[DEFAULT_RISK_CLASS];
const REMEDIATION_REPLY_SCHEMA_VERSION = 1;
const REMEDIATION_REPLY_KIND = 'adversarial-review-remediation-reply';
const FOLLOW_UP_JOB_DIRS = Object.freeze({
  pending: ['data', 'follow-up-jobs', 'pending'],
  inProgress: ['data', 'follow-up-jobs', 'in-progress'],
  completed: ['data', 'follow-up-jobs', 'completed'],
  failed: ['data', 'follow-up-jobs', 'failed'],
  stopped: ['data', 'follow-up-jobs', 'stopped'],
  workspaces: ['data', 'follow-up-jobs', 'workspaces'],
});

function getFollowUpJobDir(rootDir, key) {
  const parts = FOLLOW_UP_JOB_DIRS[key];
  if (!parts) {
    throw new Error(`Unknown follow-up job directory key: ${key}`);
  }

  return join(rootDir, ...parts);
}

function ensureFollowUpJobDirs(rootDir) {
  Object.keys(FOLLOW_UP_JOB_DIRS).forEach((key) => {
    mkdirSync(getFollowUpJobDir(rootDir, key), { recursive: true });
  });
}

function writeFollowUpJob(jobPath, job) {
  writeFileAtomic(jobPath, `${JSON.stringify(job, null, 2)}\n`);
}

function normalizeMaxRounds(maxRounds, { fallback = LEGACY_DEFAULT_MAX_REMEDIATION_ROUNDS } = {}) {
  return Number.isInteger(maxRounds) && maxRounds > 0
    ? maxRounds
    : fallback;
}

function normalizeRiskClass(riskClass, { fallback = null } = {}) {
  const normalized = String(riskClass ?? '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(ROUND_BUDGET_BY_RISK_CLASS, normalized)
    ? normalized
    : fallback;
}

function buildRoundBudgetResolution({
  riskClass = DEFAULT_RISK_CLASS,
  roundBudget = ROUND_BUDGET_BY_RISK_CLASS[DEFAULT_RISK_CLASS],
  source = 'default-medium',
} = {}) {
  const normalizedRiskClass = normalizeRiskClass(riskClass, { fallback: DEFAULT_RISK_CLASS });
  const normalizedRoundBudget = normalizeMaxRounds(
    roundBudget,
    { fallback: ROUND_BUDGET_BY_RISK_CLASS[normalizedRiskClass] }
  );

  return {
    riskClass: normalizedRiskClass,
    roundBudget: normalizedRoundBudget,
    source,
  };
}

function getProjectsDir(rootDir) {
  const candidates = [
    join(rootDir, 'projects'),
    resolve(rootDir, '..', '..', 'projects'),
  ];

  return candidates.find((candidate) => existsSync(candidate)) || candidates[0];
}

function listLinearMappingPaths(dirPath) {
  if (!existsSync(dirPath)) {
    return [];
  }

  const results = [];
  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    const entryPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...listLinearMappingPaths(entryPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.linear-mapping.json')) {
      results.push(entryPath);
    }
  }
  return results.sort();
}

function readJsonFileIfPresent(filePath) {
  if (!existsSync(filePath)) {
    return null;
  }

  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function resolveRiskClassForLinearTicket(linearTicketId, { rootDir }) {
  const normalizedTicketId = String(linearTicketId ?? '').trim().toUpperCase();
  if (!normalizedTicketId) {
    return buildRoundBudgetResolution({ source: 'default-medium' });
  }

  const projectsDir = getProjectsDir(rootDir);
  for (const mappingPath of listLinearMappingPaths(projectsDir)) {
    try {
      const mapping = readJsonFileIfPresent(mappingPath);
      if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
        continue;
      }

      const ticketEntry = Object.entries(mapping).find(([, ticketId]) => (
        String(ticketId ?? '').trim().toUpperCase() === normalizedTicketId
      ));
      if (!ticketEntry) {
        continue;
      }

      const [planTicketId] = ticketEntry;
      const planPath = mappingPath.replace(/\.linear-mapping\.json$/u, '');
      const plan = readJsonFileIfPresent(planPath);
      const planTicket = Array.isArray(plan?.tickets)
        ? plan.tickets.find((ticket) => String(ticket?.id ?? '').trim() === String(planTicketId).trim())
        : null;
      const riskClass = normalizeRiskClass(planTicket?.riskClass);

      if (!riskClass) {
        continue;
      }

      return buildRoundBudgetResolution({
        riskClass,
        roundBudget: ROUND_BUDGET_BY_RISK_CLASS[riskClass],
        source: `plan:${planPath}`,
      });
    } catch {}
  }

  return buildRoundBudgetResolution({ source: normalizedTicketId ? 'default-medium' : 'default-medium' });
}

function resolveRoundBudgetForJob(job, { rootDir, preferPersisted = true } = {}) {
  const persistedRiskClass = normalizeRiskClass(job?.riskClass);
  const persistedRoundBudget = Number(
    job?.remediationPlan?.maxRounds
      || job?.recommendedFollowUpAction?.maxRounds
  );

  // Persisted state is authoritative once it exists. Migration guarantee:
  // a legacy job persisted with `maxRounds=6` (created under the older
  // uniform-cap regime) must not be silently downgraded by recomputing
  // the budget from the current ROUND_BUDGET_BY_RISK_CLASS table. Spec
  // risk-tier changes for an already-created job require an explicit
  // migration, not an implicit override of the JSON record. Without
  // this precedence the legacy `maxRounds=6` job would collapse to the
  // `medium=1` budget and lose five rounds of remediation budget mid-
  // deploy.
  if (preferPersisted && Number.isInteger(persistedRoundBudget) && persistedRoundBudget > 0) {
    return buildRoundBudgetResolution({
      riskClass: persistedRiskClass || DEFAULT_RISK_CLASS,
      roundBudget: persistedRoundBudget,
      source: 'job-persisted-maxRounds',
    });
  }

  if (persistedRiskClass) {
    return buildRoundBudgetResolution({
      riskClass: persistedRiskClass,
      roundBudget: ROUND_BUDGET_BY_RISK_CLASS[persistedRiskClass],
      source: 'job-risk-class',
    });
  }

  return resolveRiskClassForLinearTicket(job?.linearTicketId, { rootDir });
}

function buildRemediationRoundPlan(maxRounds = DEFAULT_MAX_REMEDIATION_ROUNDS) {
  const normalizedMaxRounds = normalizeMaxRounds(maxRounds);

  return {
    mode: 'bounded-manual-rounds',
    maxRounds: normalizedMaxRounds,
    currentRound: 0,
    rounds: [],
    stopReason: null,
    stop: null,
    nextAction: {
      type: 'consume-pending-round',
      round: 1,
      operatorVisibility: 'explicit',
    },
  };
}

function buildRecommendedFollowUpAction({ critical }) {
  return {
    type: 'address-adversarial-review',
    priority: critical ? 'high' : 'normal',
    summary: critical
      ? 'Start a follow-up coding session for this PR immediately and address the critical review findings first.'
      : 'Start a follow-up coding session for this PR and address the adversarial review findings.',
    executionModel: 'bounded-manual-rounds',
    maxRounds: DEFAULT_MAX_REMEDIATION_ROUNDS,
    futureArchitectureNote: 'Long term this should resume the original build session and preserve original build intent/context instead of spawning a fresh session from a file handoff.',
  };
}

function buildRemediationReplyArtifact(outputPath) {
  return {
    kind: REMEDIATION_REPLY_KIND,
    schemaVersion: REMEDIATION_REPLY_SCHEMA_VERSION,
    state: 'awaiting-worker-write',
    path: outputPath ?? null,
  };
}

function buildRemediationReply({
  job,
  outcome = 'completed',
  summary,
  validation = [],
  blockers = [],
  // Per-finding accountability fields. Both default to [] for backward
  // compatibility — older worker replies that predate this schema
  // simply omit them, and the renderer treats an empty array as "no
  // section to print." Workers that DO report per-finding state get
  // structured rendering in the public PR comment so the reader can
  // see, for each blocking issue from the adversarial review, whether
  // it was fixed (`addressed`), deliberately disagreed with
  // (`pushback`), or hard-exited on (`blockers`). All three carry a
  // per-entry `finding` so the next human can map each entry back to
  // the originating review item without guessing.
  addressed = [],
  pushback = [],
  reReviewRequested = false,
  reReviewReason = null,
}) {
  if (!job?.jobId) {
    throw new Error('Cannot build remediation reply without a job record');
  }

  return {
    kind: REMEDIATION_REPLY_KIND,
    schemaVersion: REMEDIATION_REPLY_SCHEMA_VERSION,
    jobId: job.jobId,
    repo: job.repo,
    prNumber: job.prNumber,
    outcome,
    summary,
    validation,
    addressed,
    pushback,
    blockers,
    reReview: {
      requested: Boolean(reReviewRequested),
      reason: reReviewRequested
        ? (reReviewReason || 'Remediation applied and ready for another adversarial review pass.')
        : null,
    },
  };
}

// Known placeholder/template strings that the prompt prefills (or used
// to prefill) as shape examples for the worker. Templated agent
// outputs routinely leak example text unchanged when the worker copies
// the contract verbatim — catching it here keeps the placeholders out
// of the public PR comment AND prevents a fake-accountability reply
// from flipping `reReview.requested = true` and burning another round.
//
// EXACT-STRING matching only. An earlier version of this check used
// prefix patterns (`/^Replace (this )?with\b/i`, `/^Optional list of
// files\b/i`) that produced false positives on legitimate review
// language — a real finding like "Replace this regex; it can backtrack
// exponentially" or a real action like "Replace with parameterized
// queries" would hard-fail validation and stop the remediation round
// as `invalid-remediation-reply`. The exact-string set below covers the
// strings the current prompt template (`src/follow-up-remediation.mjs`)
// emits, plus historical placeholders that earlier prompt versions
// included in the contract example so a worker pulling a stale template
// still gets caught. Whitespace at either end is trimmed before
// comparison; otherwise the match is byte-exact.
const PLACEHOLDER_EXACT_STRINGS = new Set([
  // Current prompt placeholders.
  'Replace this with a short remediation summary.',
  'Replace with validation you ran.',
  // Historical per-finding placeholders from earlier prompt versions
  // (commit c74eeb6 era). Workers that reused a stale prompt template
  // could still emit these.
  'Replace with the review finding this entry addresses.',
  'Replace with what you did to address it.',
  'Optional list of files changed for this finding.',
  'Replace with a finding you deliberately did NOT change the code on.',
  'Replace with a finding you deliberately did NOT change the code on. Remove this entry entirely if you addressed everything.',
  'Replace with one sharp sentence on why you disagreed.',
  'Replace with the reason this PR should receive another adversarial review pass.',
]);

function assertNoPlaceholderText(value, locationLabel) {
  if (typeof value !== 'string') return;
  const trimmed = value.trim();
  if (!trimmed) return;
  if (PLACEHOLDER_EXACT_STRINGS.has(trimmed)) {
    throw new Error(
      `Remediation reply ${locationLabel} contains placeholder/example text ` +
        `from the prompt template; replace it with real content before submitting`
    );
  }
}

function validateStringArrayField(items, fieldName) {
  if (!Array.isArray(items)) {
    throw new Error(`Remediation reply ${fieldName} must be an array`);
  }

  items.forEach((item, index) => {
    if (typeof item !== 'string' || !item.trim()) {
      throw new Error(`Remediation reply ${fieldName}[${index}] must be a non-empty string`);
    }
    assertNoPlaceholderText(item, `${fieldName}[${index}]`);
  });
}

function validateOptionalTitle(entry, fieldName) {
  if (entry.title === undefined) return;
  if (typeof entry.title !== 'string' || !entry.title.trim()) {
    throw new Error(`Remediation reply ${fieldName}.title must be a non-empty string when provided`);
  }
  assertNoPlaceholderText(entry.title, `${fieldName}.title`);
}

// addressed[] entries are { title?, finding, action, files? } where files is
// an optional array of strings (the worker can list paths it touched
// while addressing the finding). Per-entry validation rejects a
// missing or empty finding/action so the public PR comment never
// renders an empty bullet, but tolerates files being absent.
function validateAddressedField(items) {
  if (!Array.isArray(items)) {
    throw new Error('Remediation reply addressed must be an array');
  }
  items.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Remediation reply addressed[${index}] must be an object`);
    }
    if (typeof entry.finding !== 'string' || !entry.finding.trim()) {
      throw new Error(`Remediation reply addressed[${index}].finding must be a non-empty string`);
    }
    if (typeof entry.action !== 'string' || !entry.action.trim()) {
      throw new Error(`Remediation reply addressed[${index}].action must be a non-empty string`);
    }
    validateOptionalTitle(entry, `addressed[${index}]`);
    assertNoPlaceholderText(entry.finding, `addressed[${index}].finding`);
    assertNoPlaceholderText(entry.action, `addressed[${index}].action`);
    if (entry.files !== undefined) {
      if (!Array.isArray(entry.files)) {
        throw new Error(`Remediation reply addressed[${index}].files must be an array if provided`);
      }
      entry.files.forEach((f, fi) => {
        if (typeof f !== 'string' || !f.trim()) {
          throw new Error(`Remediation reply addressed[${index}].files[${fi}] must be a non-empty string`);
        }
        assertNoPlaceholderText(f, `addressed[${index}].files[${fi}]`);
      });
    }
  });
}

// pushback[] entries are { title?, finding, reasoning }. Finding and
// reasoning are required and non-empty. This is the slot for "I read
// the finding, decided not to change the code, here's why." Distinct
// from blockers (hard exit) and addressed (fix applied).
function validatePushbackField(items) {
  if (!Array.isArray(items)) {
    throw new Error('Remediation reply pushback must be an array');
  }
  items.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Remediation reply pushback[${index}] must be an object`);
    }
    if (typeof entry.finding !== 'string' || !entry.finding.trim()) {
      throw new Error(`Remediation reply pushback[${index}].finding must be a non-empty string`);
    }
    if (typeof entry.reasoning !== 'string' || !entry.reasoning.trim()) {
      throw new Error(`Remediation reply pushback[${index}].reasoning must be a non-empty string`);
    }
    validateOptionalTitle(entry, `pushback[${index}]`);
    assertNoPlaceholderText(entry.finding, `pushback[${index}].finding`);
    assertNoPlaceholderText(entry.reasoning, `pushback[${index}].reasoning`);
  });
}

// blockers[] entries are EITHER:
//   - structured object: { title?, finding, reasoning?, needsHumanInput? }
//     `finding` always required, plus at least one of `reasoning` or
//     `needsHumanInput` (both can be present). The structured form
//     ties each blocker back to the originating review finding so the
//     next human reading the public PR comment can identify exactly
//     which item is unresolved.
//   - legacy non-empty string: free-text blocker description.
//     Predates the structured contract. The renderer in
//     `pr-comments.mjs` (line ~172) already handles strings; the
//     validator must also accept them under `schemaVersion: 1` so
//     previously-persisted reply artifacts (re-read during
//     reconciliation and comment recovery) do not become invalid data
//     after deploy. Keeping `schemaVersion: 1` backward-compatible
//     here is the cheaper of the two paths the reviewer flagged
//     (versus bumping to v2 + branched validation + migration tests).
function validateBlockersField(items) {
  if (!Array.isArray(items)) {
    throw new Error('Remediation reply blockers must be an array');
  }
  items.forEach((entry, index) => {
    if (typeof entry === 'string') {
      if (!entry.trim()) {
        throw new Error(`Remediation reply blockers[${index}] must be a non-empty string`);
      }
      assertNoPlaceholderText(entry, `blockers[${index}]`);
      return;
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Remediation reply blockers[${index}] must be a non-empty string or an object`);
    }
    if (typeof entry.finding !== 'string' || !entry.finding.trim()) {
      throw new Error(`Remediation reply blockers[${index}].finding must be a non-empty string`);
    }
    validateOptionalTitle(entry, `blockers[${index}]`);
    const hasReasoning = typeof entry.reasoning === 'string' && entry.reasoning.trim();
    const hasNeedsHumanInput = typeof entry.needsHumanInput === 'string' && entry.needsHumanInput.trim();
    if (!hasReasoning && !hasNeedsHumanInput) {
      throw new Error(
        `Remediation reply blockers[${index}] must include a non-empty reasoning or needsHumanInput field`
      );
    }
    if (entry.reasoning !== undefined && !hasReasoning) {
      throw new Error(`Remediation reply blockers[${index}].reasoning must be a non-empty string when provided`);
    }
    if (entry.needsHumanInput !== undefined && !hasNeedsHumanInput) {
      throw new Error(`Remediation reply blockers[${index}].needsHumanInput must be a non-empty string when provided`);
    }
    assertNoPlaceholderText(entry.finding, `blockers[${index}].finding`);
    if (hasReasoning) {
      assertNoPlaceholderText(entry.reasoning, `blockers[${index}].reasoning`);
    }
    if (hasNeedsHumanInput) {
      assertNoPlaceholderText(entry.needsHumanInput, `blockers[${index}].needsHumanInput`);
    }
  });
}

// Parse the `## Blocking Issues` section into structured findings. The
// reviewer prompt (`prompts/reviewer-prompt.md`) requires:
//   - one bullet item per finding, each with `Title:` / `File:` /
//     `Lines:` / `Problem:` / `Why it matters:` / `Recommended fix:`
//     fields
//   - the literal sentinel `- None.` when the section is empty
// Two render shapes are both compliant with that prompt:
//   1. one top-level `- File:` bullet per finding, with the rest of
//      the fields as 2-space-indented continuation lines (no marker)
//   2. five top-level bullets per finding (`- File:`, `- Lines:`,
//      `- Problem:`, `- Why it matters:`, `- Recommended fix:`)
// Both shapes contain exactly one `- File:` field bullet per finding,
// so the finding-boundary marker is `- File:` (with optional leading
// whitespace), not "any column-0 dash."
//
// Returns `null` when the section is absent (caller opts out of
// coverage enforcement). Returns `[]` when the section exists but is
// empty or contains only the `- None.` sentinel. Returns one entry
// per finding otherwise, with extracted `file` / `lines` / `problem`
// fields preserved for diagnostics.
function parseBlockingFindingsSection(reviewBody) {
  if (typeof reviewBody !== 'string' || !reviewBody.trim()) return null;
  const match = reviewBody.match(/##\s+Blocking\s+Issues?\s*\n([\s\S]*?)(?=\n##\s+|$)/i);
  if (!match) return null;
  const section = match[1].trim();
  if (!section) return [];
  // The reviewer prompt mandates `- None.` as the explicit empty
  // sentinel. Recognize it (with or without trailing period; tolerate
  // case variation) before the count step so an empty section is not
  // miscounted as a finding.
  const lines = section.split(/\n/);
  const isSentinelOnly = lines.every((l) => {
    const t = l.trim();
    return t === '' || /^-\s+None\.?$/i.test(t);
  });
  if (isSentinelOnly) return [];

  const findings = [];
  let current = null;
  for (const raw of lines) {
    const fileMatch = raw.match(/^[ \t]*-[ \t]+File[ \t]*:[ \t]*(.*)$/i);
    if (fileMatch) {
      if (current) findings.push(current);
      current = { file: fileMatch[1].trim() };
      continue;
    }
    if (!current) continue;
    const linesField = raw.match(/^[ \t]*(?:-[ \t]+)?Lines[ \t]*:[ \t]*(.*)$/i);
    if (linesField && current.lines === undefined) {
      current.lines = linesField[1].trim();
      continue;
    }
    const problemField = raw.match(/^[ \t]*(?:-[ \t]+)?Problem[ \t]*:[ \t]*(.*)$/i);
    if (problemField && current.problem === undefined) {
      current.problem = problemField[1].trim();
    }
  }
  if (current) findings.push(current);
  return findings;
}

function countBlockingFindingsInReview(reviewBody) {
  const findings = parseBlockingFindingsSection(reviewBody);
  return findings === null ? null : findings.length;
}

function usesPerFindingReplyContract(reply) {
  if (!reply || typeof reply !== 'object') return false;
  if (reply.addressed !== undefined || reply.pushback !== undefined) {
    return true;
  }

  return Array.isArray(reply.blockers) && reply.blockers.some(
    (entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
  );
}

// Enforce that the reply records the same number of accountability
// entries as there are blocking findings in the review body, summed
// across `addressed[]`, `pushback[]`, and `blockers[]`. Without this
// the prompt's per-finding contract is documentation-only — a worker
// can omit findings entirely, claim rereview readiness on a subset of
// the review, and the public PR comment becomes a misleading durable
// record.
//
// Limit of this check (deliberate, documented): it validates count
// only. It does NOT verify that the worker's free-form `finding`
// strings semantically correspond to the parsed review findings — a
// worker could submit N arbitrary strings and pass. Closing that gap
// requires a richer schema where the worker references findings by
// stable IDs the prompt provides; that is a future schema bump
// (tracked as a known follow-up). Free-form-text uniqueness was
// previously enforced here but removed because it rejected legitimate
// replies in which two distinct review findings (e.g. the same bug in
// two files) collapsed to the same paraphrase, with no benefit since
// distinct strings are not the same as correct strings.
//
// Backward-compat: enforced only when the reply opts into the new
// schema (signaled by `addressed[]`, `pushback[]`, or structured
// blocker objects) AND we can confidently parse the review body's
// blocking section. Legacy replies (string-array blockers, no
// addressed/pushback) skip the check so re-reading old persisted
// artifacts doesn't fail.
function validateBlockingCoverage(reply, expectedJob) {
  if (!expectedJob || typeof expectedJob !== 'object') return;
  const usesNewSchema = usesPerFindingReplyContract(reply);
  if (!usesNewSchema) return;

  const expected = countBlockingFindingsInReview(expectedJob.reviewBody);
  if (expected === null || expected === 0) return;

  const addressed = Array.isArray(reply.addressed) ? reply.addressed : [];
  const pushback = Array.isArray(reply.pushback) ? reply.pushback : [];
  const blockers = Array.isArray(reply.blockers) ? reply.blockers : [];
  const total = addressed.length + pushback.length + blockers.length;

  if (total !== expected) {
    throw new Error(
      `Remediation reply does not account for every blocking finding: ` +
        `review has ${expected} blocking issue(s), reply records ${total} ` +
        `(addressed=${addressed.length}, pushback=${pushback.length}, blockers=${blockers.length}). ` +
        `Each blocking issue must appear exactly once across addressed[], pushback[], or blockers[].`
    );
  }
}

function validateRemediationReply(reply, { expectedJob = null } = {}) {
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) {
    throw new Error('Remediation reply must be a JSON object');
  }

  if (reply.kind !== REMEDIATION_REPLY_KIND) {
    throw new Error(`Remediation reply kind must be ${REMEDIATION_REPLY_KIND}`);
  }

  if (reply.schemaVersion !== REMEDIATION_REPLY_SCHEMA_VERSION) {
    throw new Error(`Unsupported remediation reply schemaVersion: ${reply.schemaVersion}`);
  }

  if (typeof reply.jobId !== 'string' || !reply.jobId.trim()) {
    throw new Error('Remediation reply jobId is required');
  }

  if (typeof reply.repo !== 'string' || !reply.repo.trim()) {
    throw new Error('Remediation reply repo is required');
  }

  if (!Number.isInteger(reply.prNumber) || reply.prNumber <= 0) {
    throw new Error('Remediation reply prNumber must be a positive integer');
  }

  if (typeof reply.summary !== 'string' || !reply.summary.trim()) {
    throw new Error('Remediation reply summary is required');
  }
  assertNoPlaceholderText(reply.summary, 'summary');

  const allowedOutcomes = new Set(['completed', 'blocked', 'partial']);
  if (!allowedOutcomes.has(reply.outcome)) {
    throw new Error(`Remediation reply outcome must be one of: ${Array.from(allowedOutcomes).join(', ')}`);
  }

  validateStringArrayField(reply.validation, 'validation');
  validateBlockersField(reply.blockers);

  // addressed[] / pushback[] are additive — replies that omit them
  // entirely are still valid (legacy worker output, jobs created before
  // this schema landed). Only validate shape when the fields are
  // present. Workers that emit them get strict enforcement so a
  // half-formed entry never reaches the public PR comment renderer.
  if (reply.addressed !== undefined) {
    validateAddressedField(reply.addressed);
  }
  if (reply.pushback !== undefined) {
    validatePushbackField(reply.pushback);
  }

  if (!reply.reReview || typeof reply.reReview !== 'object' || Array.isArray(reply.reReview)) {
    throw new Error('Remediation reply reReview must be an object');
  }

  if (typeof reply.reReview.requested !== 'boolean') {
    throw new Error('Remediation reply reReview.requested must be a boolean');
  }

  if (reply.reReview.requested && (typeof reply.reReview.reason !== 'string' || !reply.reReview.reason.trim())) {
    throw new Error('Remediation reply reReview.reason is required when reReview.requested is true');
  }

  if (reply.reReview.requested) {
    assertNoPlaceholderText(reply.reReview.reason, 'reReview.reason');
  }

  // Cross-field semantic invariants. Without these the prompt's hard
  // contract ("populate blockers → set reReview.requested = false")
  // is documentation-only — a contradictory reply slips into
  // reconciliation and corrupts queue state (e.g. `outcome: blocked`
  // with `reReview.requested = true` re-arms the watcher AND posts a
  // PR comment claiming both "human intervention required" and
  // "re-review queued" for the same unresolved state).
  const usesNewSchema = usesPerFindingReplyContract(reply);
  const blockersPopulated = reply.blockers.length > 0;

  if (usesNewSchema && blockersPopulated && reply.reReview.requested) {
    throw new Error(
      'Remediation reply contradicts itself: blockers are populated but reReview.requested is true. ' +
        'A populated blockers list is a hard exit; set reReview.requested = false.'
    );
  }

  if (reply.outcome === 'blocked') {
    if (!blockersPopulated) {
      throw new Error(
        'Remediation reply outcome is "blocked" but blockers is empty. ' +
          'A blocked outcome must list the unresolved blockers.'
      );
    }
    if (usesNewSchema && reply.reReview.requested) {
      throw new Error(
        'Remediation reply outcome is "blocked" but reReview.requested is true. ' +
          'A blocked outcome must set reReview.requested = false.'
      );
    }
  }

  if (usesNewSchema && reply.outcome === 'completed' && blockersPopulated) {
    throw new Error(
      'Remediation reply outcome is "completed" but blockers is non-empty. ' +
        'Use outcome "partial" or "blocked" when unresolved blockers remain.'
    );
  }

  if (expectedJob) {
    if (reply.jobId !== expectedJob.jobId) {
      throw new Error(`Remediation reply jobId mismatch: expected ${expectedJob.jobId}, got ${reply.jobId}`);
    }

    if (reply.repo !== expectedJob.repo) {
      throw new Error(`Remediation reply repo mismatch: expected ${expectedJob.repo}, got ${reply.repo}`);
    }

    if (reply.prNumber !== expectedJob.prNumber) {
      throw new Error(`Remediation reply prNumber mismatch: expected ${expectedJob.prNumber}, got ${reply.prNumber}`);
    }

    validateBlockingCoverage(reply, expectedJob);
  }

  return reply;
}

function readRemediationReplyArtifact(replyPath, { expectedJob = null } = {}) {
  try {
    return validateRemediationReply(
      JSON.parse(readFileSync(replyPath, 'utf8')),
      { expectedJob }
    );
  } catch (err) {
    const jobContext = expectedJob
      ? ` for job ${expectedJob.jobId} (${expectedJob.repo}#${expectedJob.prNumber})`
      : '';
    throw new Error(
      `Failed to read remediation reply artifact at ${replyPath}${jobContext}: ${err.message}`,
      { cause: err }
    );
  }
}

// Best-effort recovery of renderable fields from a remediation reply
// that did NOT pass strict validation. Returns null when the file
// cannot even be parsed as JSON. When the file IS valid JSON, returns
// only the fields the PR-comment renderer can use, with conservative
// type checks so we don't pass garbage into the comment body. Strict
// validation still gates the state machine — this helper is only for
// salvaging the worker's prose for the operator-facing failure comment
// so a single contract violation doesn't throw away the worker's
// point-by-point response.
function salvagePartialRemediationReply(replyPath) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(replyPath, 'utf8'));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }

  const isStr = (v) => typeof v === 'string' && v.trim().length > 0;
  const partial = {};

  if (isStr(raw.summary)) {
    partial.summary = raw.summary;
  }

  if (Array.isArray(raw.validation)) {
    const v = raw.validation.filter(isStr);
    if (v.length) partial.validation = v;
  }

  if (Array.isArray(raw.addressed)) {
    const a = raw.addressed.filter(
      (e) => e && typeof e === 'object' && !Array.isArray(e) && isStr(e.finding) && isStr(e.action)
    );
    if (a.length) partial.addressed = a;
  }

  if (Array.isArray(raw.pushback)) {
    const p = raw.pushback.filter(
      (e) => e && typeof e === 'object' && !Array.isArray(e) && isStr(e.finding) && isStr(e.reasoning)
    );
    if (p.length) partial.pushback = p;
  }

  if (Array.isArray(raw.blockers)) {
    const b = raw.blockers.filter((e) => {
      if (typeof e === 'string') return e.trim().length > 0;
      if (!e || typeof e !== 'object' || Array.isArray(e)) return false;
      return isStr(e.finding);
    });
    if (b.length) partial.blockers = b;
  }

  return Object.keys(partial).length ? partial : null;
}

function buildLegacyRemediationPlan(job) {
  const maxRounds = normalizeMaxRounds(
    Number(job?.remediationPlan?.maxRounds)
      || Number(job?.recommendedFollowUpAction?.maxRounds),
    { fallback: LEGACY_DEFAULT_MAX_REMEDIATION_ROUNDS }
  );
  const basePlan = buildRemediationRoundPlan(maxRounds);
  const status = String(job?.status || 'pending');

  if (status === 'pending') {
    return basePlan;
  }

  const round = {
    round: 1,
    state: 'claimed',
  };

  if (job?.claimedAt) {
    round.claimedAt = job.claimedAt;
  }
  if (job?.claimedBy) {
    round.claimedBy = job.claimedBy;
  }
  if (job?.remediationWorker) {
    round.worker = job.remediationWorker;
  }
  if (job?.remediationWorker?.spawnedAt) {
    round.spawnedAt = job.remediationWorker.spawnedAt;
  }

  if (status === 'in_progress') {
    round.state = job?.remediationWorker?.state === 'spawned' ? 'spawned' : 'claimed';
    return {
      ...basePlan,
      currentRound: 1,
      rounds: [round],
      nextAction: {
        type: round.state === 'spawned' ? 'reconcile-worker' : 'worker-spawn',
        round: 1,
        operatorVisibility: 'explicit',
      },
    };
  }

  if (status === 'completed') {
    round.state = 'completed';
    round.finishedAt = job?.completedAt || null;
    round.completion = job?.completion || null;
  } else if (status === 'failed') {
    round.state = 'failed';
    round.finishedAt = job?.failedAt || null;
    round.failure = job?.failure || null;
  } else if (status === 'stopped') {
    round.state = 'stopped';
    round.finishedAt = job?.stoppedAt || null;
  }

  return {
    ...basePlan,
    currentRound: 1,
    rounds: [round],
    stopReason: status === 'stopped' ? job?.remediationPlan?.stopReason || job?.stopReason || null : null,
    stop: status === 'stopped'
      ? buildStopMetadata({
          code: job?.remediationPlan?.stop?.code || 'stopped',
          reason: job?.remediationPlan?.stopReason || job?.stopReason || null,
          stoppedAt: job?.stoppedAt || null,
          sourceStatus: job?.remediationPlan?.stop?.sourceStatus || status,
          currentRound: 1,
          maxRounds,
        })
      : null,
    nextAction: null,
  };
}

function normalizeRound(round, index, fallbackState = 'claimed') {
  const roundNumber = Number(round?.round ?? index + 1);
  return {
    ...round,
    round: roundNumber > 0 ? roundNumber : index + 1,
    state: round?.state || fallbackState,
  };
}

function buildStopMetadata({
  code,
  reason,
  stoppedAt,
  stoppedBy = null,
  sourceStatus = null,
  currentRound = null,
  maxRounds = null,
}) {
  return {
    code: typeof code === 'string' && code.trim() ? code : 'stopped',
    reason: typeof reason === 'string' && reason.trim() ? reason : 'Follow-up remediation stopped.',
    stoppedAt: stoppedAt || null,
    stoppedBy: stoppedBy || null,
    sourceStatus: sourceStatus || null,
    currentRound: Number.isInteger(currentRound) && currentRound > 0 ? currentRound : null,
    maxRounds: Number.isInteger(maxRounds) && maxRounds > 0 ? maxRounds : null,
  };
}

function selectStopCode({ currentRound, maxRounds, requestedStopCode }) {
  if (currentRound >= maxRounds && requestedStopCode !== 'operator-stop') {
    return 'max-rounds-reached';
  }

  return requestedStopCode || 'stopped';
}

function normalizeRemediationPlan(job) {
  if (job?.schemaVersion === FOLLOW_UP_JOB_SCHEMA_VERSION && job?.remediationPlan) {
    const currentRound = Math.max(0, Number(job.remediationPlan.currentRound || 0));
    const maxRounds = normalizeMaxRounds(
      Number(job.remediationPlan.maxRounds || job?.recommendedFollowUpAction?.maxRounds),
      { fallback: LEGACY_DEFAULT_MAX_REMEDIATION_ROUNDS }
    );
    const persistedStopReason = typeof job.remediationPlan.stop?.reason === 'string'
      && job.remediationPlan.stop.reason.trim()
      ? job.remediationPlan.stop.reason
      : job.remediationPlan.stopReason;
    const rounds = Array.isArray(job.remediationPlan.rounds)
      ? job.remediationPlan.rounds.map((round, index) => normalizeRound(round, index))
      : [];

    return {
      ...buildRemediationRoundPlan(
        maxRounds
      ),
      ...job.remediationPlan,
      mode: 'bounded-manual-rounds',
      maxRounds,
      currentRound,
      rounds,
      stop: job.remediationPlan.stop && typeof job.remediationPlan.stop === 'object'
        ? buildStopMetadata({
            code: job.remediationPlan.stop.code,
            reason: persistedStopReason,
            stoppedAt: job.remediationPlan.stop.stoppedAt,
            stoppedBy: job.remediationPlan.stop.stoppedBy,
            sourceStatus: job.remediationPlan.stop.sourceStatus,
            currentRound,
            maxRounds,
          })
        : null,
    };
  }

  return buildLegacyRemediationPlan(job);
}

function normalizeFollowUpJob(job) {
  if (!job || typeof job !== 'object') {
    return job;
  }

  const remediationPlan = normalizeRemediationPlan(job);
  const persistedRemediationReply = job?.remediationReply;
  const normalizedRemediationReplyPath = typeof persistedRemediationReply?.path === 'string'
    && persistedRemediationReply.path.trim()
    ? persistedRemediationReply.path
    : null;
  const normalizedRiskClass = normalizeRiskClass(job?.riskClass);
  return {
    ...job,
    schemaVersion: FOLLOW_UP_JOB_SCHEMA_VERSION,
    riskClass: normalizedRiskClass,
    recommendedFollowUpAction: {
      ...buildRecommendedFollowUpAction({ critical: job.critical }),
      ...(job.recommendedFollowUpAction || {}),
      executionModel: 'bounded-manual-rounds',
      maxRounds: remediationPlan.maxRounds,
    },
    remediationReply: {
      ...buildRemediationReplyArtifact(null),
      kind: REMEDIATION_REPLY_KIND,
      schemaVersion: REMEDIATION_REPLY_SCHEMA_VERSION,
      state: typeof persistedRemediationReply?.state === 'string' && persistedRemediationReply.state.trim()
        ? persistedRemediationReply.state
        : 'awaiting-worker-write',
      path: normalizedRemediationReplyPath,
    },
    remediationPlan,
  };
}

function readFollowUpJob(jobPath) {
  return normalizeFollowUpJob(JSON.parse(readFileSync(jobPath, 'utf8')));
}

function listPendingFollowUpJobPaths(rootDir) {
  const pendingDir = getFollowUpJobDir(rootDir, 'pending');
  if (!existsSync(pendingDir)) return [];

  return readdirSync(pendingDir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => join(pendingDir, name));
}

function listInProgressFollowUpJobPaths(rootDir) {
  const inProgressDir = getFollowUpJobDir(rootDir, 'inProgress');
  if (!existsSync(inProgressDir)) return [];

  return readdirSync(inProgressDir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => join(inProgressDir, name));
}

function listPendingFollowUpJobs(rootDir) {
  return listPendingFollowUpJobPaths(rootDir).map((jobPath) => ({
    job: readFollowUpJob(jobPath),
    jobPath,
  }));
}

function listInProgressFollowUpJobs(rootDir) {
  return listInProgressFollowUpJobPaths(rootDir).map((jobPath) => ({
    job: readFollowUpJob(jobPath),
    jobPath,
  }));
}

function listFollowUpJobsInDir(rootDir, key) {
  const dir = getFollowUpJobDir(rootDir, key);
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => ({
      job: readFollowUpJob(join(dir, name)),
      jobPath: join(dir, name),
    }));
}

// Per-PR remediation ledger summary. The bounded loop's "round number"
// must be derived from the durable follow-up-jobs ledger (the only
// counter that actually advances when remediation work completes), not
// from `reviewed_prs.review_attempts` (which also increments on
// transient post / OAuth / reviewer-crash failures and would silently
// trip the lenient final-round threshold on infrastructure flakiness).
//
// `currentRound` on terminal jobs is *cumulative* for the PR: each new
// follow-up job is seeded from the PR's prior accumulated count
// (`buildFollowUpJob` -> `priorCompletedRounds`), and `claimNext...`
// then increments it by exactly one. The PR-wide consumed-round count
// is therefore `max(currentRound)` across terminal jobs, NOT the sum.
// Summing would double-count: 3 sequential remediation cycles produce
// terminal `currentRound` stamps of 1, 2, 3 — a sum of 6 would
// prematurely trip `max-rounds-reached` at round 2 on a 3-round cap,
// and at round 3 on the legacy 6-round cap.
//
// `latestMaxRounds` is read from the most-recent job (by terminal /
// claim / create timestamp). Jobs created with the legacy 6-round cap
// must continue to use 6 as their bound — this is what the reviewer's
// blocking issue #2 calls out: do not substitute the global default.
//
// Pending and in-progress jobs are intentionally excluded from
// `completedRoundsForPR`: pending hasn't consumed a round yet, and
// in-progress is mid-flight (the round it's running has not yet
// produced a terminal outcome the gate can react to).
//
// Resilience: a single corrupt or unreadable JSON file in any of the
// scanned directories must NOT silently zero out the directory's
// contribution to the ledger for unrelated PRs. Errors are caught
// per-file (logged + skipped), not per-directory.
function summarizePRRemediationLedger(rootDir, { repo, prNumber }) {
  const targetRepo = String(repo ?? '');
  const targetPr = Number(prNumber);
  if (!targetRepo || !Number.isFinite(targetPr)) {
    return { completedRoundsForPR: 0, latestMaxRounds: null, latestJobId: null };
  }

  let completedRoundsForPR = 0;
  let latestJob = null;
  let latestTimestamp = '';

  const allKeys = ['pending', 'inProgress', 'completed', 'failed', 'stopped'];
  const terminalKeys = new Set(['completed', 'failed', 'stopped']);

  for (const key of allKeys) {
    const dir = getFollowUpJobDir(rootDir, key);
    if (!existsSync(dir)) continue;

    let names;
    try {
      names = readdirSync(dir).filter((name) => name.endsWith('.json'));
    } catch (err) {
      console.error(
        `[follow-up-jobs] Failed to list ${key} directory while summarizing ` +
          `PR ledger for ${targetRepo}#${targetPr}: ${err?.message || err}`,
      );
      continue;
    }

    for (const name of names) {
      const jobPath = join(dir, name);
      let job;
      try {
        job = readFollowUpJob(jobPath);
      } catch (err) {
        // Per-file fail-soft: a single bad JSON record cannot remove
        // history for unrelated PRs in the same directory. Logging
        // the bad path keeps the failure visible to operators.
        console.error(
          `[follow-up-jobs] Skipping unreadable ledger record ${jobPath} ` +
            `while summarizing PR ledger for ${targetRepo}#${targetPr}: ` +
            `${err?.message || err}`,
        );
        continue;
      }
      if (!job) continue;
      if (job.repo !== targetRepo) continue;
      if (Number(job.prNumber) !== targetPr) continue;

      if (terminalKeys.has(key)) {
        // `claimNextFollowUpJob` increments `currentRound` on claim,
        // before consume-time pre-spawn gates (lifecycle, round-budget,
        // OAuth pre-flight, workspace prep) run. When one of those gates
        // refuses, the terminal record carries the bumped count even
        // though no remediation worker ever started. The intended tag for
        // that path is `remediationWorker.state === 'never-spawned'`, but
        // we also treat missing/null/malformed `remediationWorker` payloads
        // as never-spawned here so a pre-spawn stop that forgot to stamp
        // the tag does not permanently burn PR-wide budget. The tradeoff is
        // that a corrupted real worker payload can overstate remaining
        // budget, so unexpected non-object shapes are logged for operators.
        const remediationWorker = job?.remediationWorker;
        const hasObjectWorkerShape = (
          remediationWorker != null
          && typeof remediationWorker === 'object'
          && !Array.isArray(remediationWorker)
        );
        if (remediationWorker != null && !hasObjectWorkerShape) {
          console.warn(
            `[follow-up-jobs] Treating malformed remediationWorker as never-spawned ` +
              `while summarizing PR ledger for ${targetRepo}#${targetPr} from ${jobPath}`,
          );
        }
        const neverSpawned = (
          remediationWorker == null
          || !hasObjectWorkerShape
          || remediationWorker.state === 'never-spawned'
        );
        if (!neverSpawned) {
          const cur = Number(job?.remediationPlan?.currentRound || 0);
          if (Number.isFinite(cur) && cur > completedRoundsForPR) {
            completedRoundsForPR = cur;
          }
        }
      }

      const ts = job?.completedAt
        || job?.failedAt
        || job?.stoppedAt
        || job?.claimedAt
        || job?.createdAt
        || '';
      if (ts > latestTimestamp) {
        latestTimestamp = ts;
        latestJob = job;
      }
    }
  }

  const latestMaxRoundsRaw = Number(latestJob?.remediationPlan?.maxRounds);
  const latestMaxRounds = Number.isFinite(latestMaxRoundsRaw) && latestMaxRoundsRaw > 0
    ? latestMaxRoundsRaw
    : null;

  // PMO-A1 / Track A: callers (watcher's pre-spawn rereview gate)
  // need to know the PR's last-recorded riskClass to decide whether
  // the round budget has been exhausted at the riskClass tier.
  // `latestRiskClass` falls back to DEFAULT_RISK_CLASS when no job
  // records a riskClass (legacy or spec-less PRs).
  const latestRiskClass = normalizeRiskClass(latestJob?.riskClass) || DEFAULT_RISK_CLASS;

  return {
    completedRoundsForPR,
    latestMaxRounds,
    latestRiskClass,
    latestJobId: latestJob?.jobId || null,
  };
}

function sanitizeRepo(repo) {
  return String(repo ?? '').replace(/\//g, '__').replace(/[^a-zA-Z0-9_.-]/g, '-');
}

function sanitizeTimestamp(timestamp) {
  return String(timestamp ?? '').replace(/[:.]/g, '-');
}

function extractReviewSummary(reviewBody) {
  const text = String(reviewBody ?? '').trim();
  if (!text) return 'No review summary captured.';

  const match = text.match(/(?:^|\n)##\s+Summary\s*\n([\s\S]*?)(?=\n##\s+|$)/i);
  if (match?.[1]?.trim()) {
    return match[1].trim();
  }

  return text.slice(0, 1000);
}

function getCurrentRound(job) {
  const roundNumber = Number(job?.remediationPlan?.currentRound || 0);
  if (roundNumber <= 0) return null;
  return job?.remediationPlan?.rounds?.find((round) => round.round === roundNumber) || null;
}

function updateCurrentRound(job, updater) {
  const currentRound = getCurrentRound(job);
  if (!currentRound) {
    throw new Error(`Follow-up job ${job?.jobId || '<unknown>'} has no active remediation round`);
  }

  return {
    ...job,
    remediationPlan: {
      ...job.remediationPlan,
      rounds: job.remediationPlan.rounds.map((round) => (
        round.round === currentRound.round ? updater(round) : round
      )),
    },
  };
}

function moveFollowUpJob(rootDir, jobPath, targetKey, nextJob) {
  ensureFollowUpJobDirs(rootDir);
  const targetPath = join(getFollowUpJobDir(rootDir, targetKey), basename(jobPath));
  writeFollowUpJob(jobPath, nextJob);
  if (targetPath !== jobPath) {
    renameSync(jobPath, targetPath);
  }
  return { job: nextJob, jobPath: targetPath };
}

function moveTerminalJobRecord({
  rootDir,
  jobPath,
  destinationKey,
  buildNextJob,
}) {
  ensureFollowUpJobDirs(rootDir);

  const terminalPath = join(getFollowUpJobDir(rootDir, destinationKey), basename(jobPath));

  let currentJob;
  try {
    currentJob = readFollowUpJob(jobPath);
  } catch (err) {
    if (err?.code === 'ENOENT' && existsSync(terminalPath)) {
      return { job: readFollowUpJob(terminalPath), jobPath: terminalPath, alreadyTerminal: true };
    }
    throw err;
  }

  if (existsSync(terminalPath)) {
    rmSync(jobPath, { force: true });
    return { job: readFollowUpJob(terminalPath), jobPath: terminalPath, alreadyTerminal: true };
  }

  const nextJob = buildNextJob(currentJob);

  try {
    writeFileAtomic(terminalPath, `${JSON.stringify(nextJob, null, 2)}\n`, { overwrite: false });
  } catch (err) {
    if (err?.code === 'EEXIST' && existsSync(terminalPath)) {
      rmSync(jobPath, { force: true });
      return { job: readFollowUpJob(terminalPath), jobPath: terminalPath, alreadyTerminal: true };
    }
    throw err;
  }

  try {
    rmSync(jobPath, { force: true });
  } catch (err) {
    rmSync(terminalPath, { force: true });
    throw err;
  }

  return { job: nextJob, jobPath: terminalPath, alreadyTerminal: false };
}

function buildFollowUpJob({
  repo,
  prNumber,
  reviewerModel,
  builderTag = null,
  linearTicketId = null,
  reviewBody,
  reviewPostedAt,
  critical,
  maxRemediationRounds = DEFAULT_MAX_REMEDIATION_ROUNDS,
  // Number of remediation rounds this PR has already completed across
  // earlier follow-up jobs. The auto-flow creates one new follow-up job
  // per adversarial review pass, so the bounded cap must be enforced
  // PR-wide, not per-job. Seeding `currentRound` with the PR's prior
  // count means `claimNextFollowUpJob`'s `currentRound >= maxRounds`
  // guard naturally stops the job after the PR exhausts its budget,
  // even though each individual job is freshly created.
  priorCompletedRounds = 0,
  // riskClass tier (low/medium/high/critical) carried from the linked
  // spec/plan. `createFollowUpJob` calls `resolveRoundBudgetForJob`
  // with this value to derive `remediationPlan.maxRounds` — the
  // pr-merge-orchestration spec's risk-tiered budget. Null for jobs
  // built without a spec linkage; falls back to DEFAULT_RISK_CLASS.
  riskClass = null,
}) {
  const createdAt = reviewPostedAt || new Date().toISOString();
  const jobId = `${sanitizeRepo(repo)}-pr-${prNumber}-${sanitizeTimestamp(createdAt)}`;
  const basePlan = buildRemediationRoundPlan(maxRemediationRounds);
  const seededRounds = Number.isFinite(Number(priorCompletedRounds)) && priorCompletedRounds > 0
    ? Math.floor(Number(priorCompletedRounds))
    : 0;
  const remediationPlan = {
    ...basePlan,
    currentRound: seededRounds,
    nextAction: {
      ...basePlan.nextAction,
      round: seededRounds + 1,
    },
  };

  return {
    schemaVersion: FOLLOW_UP_JOB_SCHEMA_VERSION,
    kind: 'adversarial-review-follow-up',
    status: 'pending',
    jobId,
    createdAt,
    trigger: {
      type: 'github-review-posted',
      postedAt: createdAt,
    },
    repo,
    prNumber,
    linearTicketId,
    riskClass: normalizeRiskClass(riskClass),
    reviewerModel,
    // Durable record of the original PR title tag so remediation routing
    // does not have to reverse-map from reviewerModel. Reverse-mapping is
    // ambiguous because both [claude-code] and [clio-agent] PRs carry
    // reviewerModel='codex'. Persisting the tag at creation time keeps the
    // builder→remediator routing deterministic.
    builderTag: builderTag || null,
    critical: Boolean(critical),
    reviewSummary: extractReviewSummary(reviewBody),
    reviewBody,
    recommendedFollowUpAction: {
      ...buildRecommendedFollowUpAction({ critical }),
      maxRounds: remediationPlan.maxRounds,
    },
    remediationReply: buildRemediationReplyArtifact(null),
    remediationPlan,
    sessionHandoff: {
      originalBuildSessionId: null,
      resumePreferred: true,
      resumeAvailable: false,
    },
  };
}

function createFollowUpJob({ rootDir, ...jobInput }) {
  const baseJob = buildFollowUpJob(jobInput);
  const { riskClass, roundBudget } = resolveRoundBudgetForJob(baseJob, {
    rootDir,
    preferPersisted: Number.isInteger(jobInput.maxRemediationRounds) && jobInput.maxRemediationRounds > 0,
  });
  // Preserve the `currentRound` seeded from `priorCompletedRounds` in
  // `buildFollowUpJob` — that's how the PR-wide bounded cap is
  // enforced across multiple follow-up jobs. Only `maxRounds` is
  // overridden by the riskClass-derived budget; the seeded round
  // count and the empty `rounds` history stay as `buildFollowUpJob`
  // wrote them.
  const resolvedJob = {
    ...baseJob,
    riskClass,
    recommendedFollowUpAction: {
      ...baseJob.recommendedFollowUpAction,
      maxRounds: roundBudget,
    },
    remediationPlan: {
      ...baseJob.remediationPlan,
      maxRounds: roundBudget,
    },
  };
  const queueDir = getFollowUpJobDir(rootDir, 'pending');

  mkdirSync(queueDir, { recursive: true });

  for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt += 1) {
    const job = attempt === 0
      ? resolvedJob
      : {
          ...resolvedJob,
          jobId: `${resolvedJob.jobId}-${attempt + 1}`,
        };
    const jobPath = join(queueDir, `${job.jobId}.json`);

    try {
      writeFileAtomic(jobPath, `${JSON.stringify(job, null, 2)}\n`, { overwrite: false });
      return { job, jobPath };
    } catch (err) {
      if (err?.code === 'EEXIST') continue;
      throw err;
    }
  }

  throw new Error(`Unable to create unique follow-up job file for ${resolvedJob.jobId} after ${MAX_CREATE_ATTEMPTS} attempts`);
}

function claimNextFollowUpJob({
  rootDir,
  workerType = 'codex-remediation',
  claimedAt = new Date().toISOString(),
  launcherPid = process.pid,
  markStoppedImpl = markFollowUpJobStopped,
  returnStopped = false,
} = {}) {
  ensureFollowUpJobDirs(rootDir);

  for (const pendingPath of listPendingFollowUpJobPaths(rootDir)) {
    const inProgressPath = join(getFollowUpJobDir(rootDir, 'inProgress'), basename(pendingPath));

    try {
      renameSync(pendingPath, inProgressPath);
    } catch (err) {
      if (err?.code === 'ENOENT') continue;
      throw err;
    }

    const job = readFollowUpJob(inProgressPath);
    const currentRound = Number(job?.remediationPlan?.currentRound || 0);
    const maxRounds = Number(job?.remediationPlan?.maxRounds || DEFAULT_MAX_REMEDIATION_ROUNDS);
    if (currentRound >= maxRounds) {
      let stopped = null;
      try {
        stopped = markStoppedImpl({
          rootDir,
          jobPath: inProgressPath,
          stoppedAt: claimedAt,
          stopCode: 'max-rounds-reached',
          sourceStatus: job.status,
          stopReason: `Reached max remediation rounds (${currentRound}/${maxRounds}) before claim.`,
        });
      } catch {}
      if (returnStopped && stopped) {
        return {
          job: stopped.job,
          jobPath: stopped.jobPath,
          stopped: true,
          reason: 'max-rounds-reached',
        };
      }
      continue;
    }

    const nextRoundNumber = currentRound + 1;
    const claimedJob = {
      ...job,
      status: 'in_progress',
      claimedAt,
      claimedBy: {
        workerType,
        launcherPid,
      },
      remediationPlan: {
        ...(job.remediationPlan || buildRemediationRoundPlan()),
        currentRound: nextRoundNumber,
        stopReason: null,
        nextAction: {
          type: 'worker-spawn',
          round: nextRoundNumber,
          operatorVisibility: 'explicit',
        },
        rounds: [
          ...(job?.remediationPlan?.rounds || []),
          {
            round: nextRoundNumber,
            state: 'claimed',
            claimedAt,
            claimedBy: {
              workerType,
              launcherPid,
            },
          },
        ],
      },
    };

    writeFollowUpJob(inProgressPath, claimedJob);
    return { job: claimedJob, jobPath: inProgressPath };
  }

  return null;
}

function markFollowUpJobSpawned({
  jobPath,
  worker,
  spawnedAt = new Date().toISOString(),
}) {
  const currentJob = readFollowUpJob(jobPath);
  let nextJob = {
    ...currentJob,
    status: 'in_progress',
    remediationWorker: {
      model: 'codex',
      state: 'spawned',
      spawnedAt,
      ...worker,
    },
    remediationReply: buildRemediationReplyArtifact(worker?.replyPath ?? null),
    remediationPlan: {
      ...currentJob.remediationPlan,
      nextAction: {
        type: 'reconcile-worker',
        round: currentJob?.remediationPlan?.currentRound || 1,
        operatorVisibility: 'explicit',
      },
    },
  };

  nextJob = updateCurrentRound(nextJob, (round) => ({
    ...round,
    state: 'spawned',
    spawnedAt,
    worker: {
      model: 'codex',
      ...worker,
    },
  }));

  if (worker?.workspaceDir) {
    nextJob.workspaceDir = worker.workspaceDir;
  }

  writeFollowUpJob(jobPath, nextJob);
  return { job: nextJob, jobPath };
}

function markFollowUpJobFailed({
  rootDir,
  jobPath,
  error,
  failedAt = new Date().toISOString(),
  failureCode = 'worker-failure',
  remediationWorker,
  failure = {},
  // Optional pre-built commentDelivery shape. When the reconcile path
  // passes this, the terminal record lands in failed/ with the field
  // already present — closing the crash window between the atomic
  // terminal move and the post-move pre-stamp in
  // `recordInitialCommentDelivery`. Reviewer R5 blocking #1 fix.
  commentDelivery = null,
}) {
  return moveTerminalJobRecord({
    rootDir,
    jobPath,
    destinationKey: 'failed',
    buildNextJob: (currentJob) => {
      const failureDetails = {
        ...failure,
        code: failureCode,
        message: error?.message || failure.message || String(error),
      };

      let nextJob = {
        ...currentJob,
        status: 'failed',
        failedAt,
        remediationWorker: remediationWorker || currentJob.remediationWorker,
        failure: failureDetails,
        remediationPlan: {
          ...(currentJob.remediationPlan || buildRemediationRoundPlan()),
          nextAction: null,
        },
      };

      // `currentRound` may be > 0 either because a worker has been
      // claimed/spawned for this job (a `rounds[]` entry exists) OR
      // because the job was created with a seeded count from the
      // PR-wide ledger (no `rounds[]` entry yet). Only update the
      // round entry when one actually exists; otherwise the top-level
      // failure metadata is the only place to record the outcome.
      if (currentJob?.remediationPlan?.currentRound > 0 && getCurrentRound(nextJob)) {
        nextJob = updateCurrentRound(nextJob, (round) => ({
          ...round,
          state: 'failed',
          finishedAt: failedAt,
          worker: remediationWorker || round.worker || currentJob.remediationWorker || null,
          failure: failureDetails,
        }));
      }

      if (commentDelivery) {
        nextJob.commentDelivery = commentDelivery;
      }

      return nextJob;
    },
  });
}

function markFollowUpJobCompleted({
  rootDir,
  jobPath,
  completion,
  completedAt,
  remediationWorker,
  remediationReply,
  reReview,
  finishedAt = new Date().toISOString(),
  completionPreview = null,
  commentDelivery = null,
}) {
  const normalizedCompletedAt = completedAt ?? finishedAt;
  const normalizedCompletion = completion || {
    preview: completionPreview,
  };

  return moveTerminalJobRecord({
    rootDir,
    jobPath,
    destinationKey: 'completed',
    buildNextJob: (currentJob) => {
      let nextJob = {
        ...currentJob,
        status: 'completed',
        completedAt: normalizedCompletedAt,
        remediationWorker: remediationWorker || currentJob.remediationWorker,
        completion: normalizedCompletion,
        remediationReply: remediationReply || currentJob.remediationReply,
        reReview: reReview || currentJob.reReview,
        remediationPlan: {
          ...(currentJob.remediationPlan || buildRemediationRoundPlan()),
          nextAction: null,
        },
      };

      if (currentJob?.remediationPlan?.currentRound > 0 && getCurrentRound(nextJob)) {
        nextJob = updateCurrentRound(nextJob, (round) => ({
          ...round,
          state: 'completed',
          finishedAt: normalizedCompletedAt,
          worker: remediationWorker || round.worker || currentJob.remediationWorker || null,
          completion: normalizedCompletion,
          remediationReply: remediationReply || round.remediationReply || currentJob.remediationReply || null,
          reReview: reReview || round.reReview || currentJob.reReview || null,
        }));
      }

      if (commentDelivery) {
        nextJob.commentDelivery = commentDelivery;
      }

      return nextJob;
    },
  });
}

// Intentionally synchronous today: stopped/ failed/ completed queue
// transitions use rename + writeFileSync so callers can treat the on-disk
// terminal record as durable immediately after return.
function markFollowUpJobStopped({
  rootDir,
  jobPath,
  stoppedAt = new Date().toISOString(),
  stopReason,
  stopCode = 'stopped',
  stoppedBy = null,
  sourceStatus = null,
  remediationWorker,
  remediationReply,
  reReview,
  completion,
  failure,
  commentDelivery = null,
}) {
  return moveTerminalJobRecord({
    rootDir,
    jobPath,
    destinationKey: 'stopped',
    buildNextJob: (currentJob) => {
      const currentRound = Number(currentJob?.remediationPlan?.currentRound || 0);
      const maxRounds = Number(currentJob?.remediationPlan?.maxRounds || DEFAULT_MAX_REMEDIATION_ROUNDS);
      const stop = buildStopMetadata({
        code: stopCode,
        reason: stopReason,
        stoppedAt,
        stoppedBy,
        sourceStatus: sourceStatus || currentJob.status || null,
        currentRound,
        maxRounds,
      });

      let nextJob = {
        ...currentJob,
        status: 'stopped',
        stoppedAt,
        remediationWorker: remediationWorker ?? currentJob.remediationWorker ?? null,
        remediationReply: remediationReply ?? currentJob.remediationReply,
        reReview: reReview ?? currentJob.reReview ?? null,
        completion: completion ?? currentJob.completion ?? null,
        failure: failure ?? currentJob.failure ?? null,
        remediationPlan: {
          ...(currentJob.remediationPlan || buildRemediationRoundPlan()),
          stopReason: stop.reason,
          stop,
          nextAction: null,
        },
      };

      if (currentRound > 0 && getCurrentRound(nextJob)) {
        nextJob = updateCurrentRound(nextJob, (round) => ({
          ...round,
          state: 'stopped',
          finishedAt: stoppedAt,
          worker: remediationWorker ?? round.worker ?? currentJob.remediationWorker ?? null,
          remediationReply: remediationReply ?? round.remediationReply ?? currentJob.remediationReply ?? null,
          reReview: reReview ?? round.reReview ?? currentJob.reReview ?? null,
          completion: completion ?? round.completion ?? currentJob.completion ?? null,
          failure: failure ?? round.failure ?? currentJob.failure ?? null,
          stop,
        }));
      }

      if (commentDelivery) {
        nextJob.commentDelivery = commentDelivery;
      }

      return nextJob;
    },
  });
}

function requeueFollowUpJobForNextRound({
  rootDir,
  jobPath,
  requestedAt = new Date().toISOString(),
  requestedBy = 'operator',
  reason = 'Additional remediation round requested.',
}) {
  const currentJob = readFollowUpJob(jobPath);
  const currentRound = Number(currentJob?.remediationPlan?.currentRound || 0);
  const maxRounds = Number(currentJob?.remediationPlan?.maxRounds || DEFAULT_MAX_REMEDIATION_ROUNDS);
  const stoppedCode = currentJob?.remediationPlan?.stop?.code || null;
  const requeueableStoppedCodes = new Set([
    'max-rounds-reached',
    'round-budget-exhausted',
  ]);
  const stopCode = selectStopCode({
    currentRound,
    maxRounds,
    requestedStopCode: currentJob.status === 'completed' && currentJob?.reReview?.requested !== true
      ? 'no-progress'
      : 'max-rounds-reached',
  });

  if (currentJob.status === 'pending' || currentJob.status === 'inProgress') {
    throw new Error(`Cannot requeue follow-up job ${currentJob.jobId} from status ${currentJob.status}`);
  }
  if (currentJob.status === 'stopped' && !requeueableStoppedCodes.has(stoppedCode)) {
    throw new Error(
      `Cannot requeue follow-up job ${currentJob.jobId} from stopped:${stoppedCode || 'unknown'}`
    );
  }
  if (!['completed', 'failed', 'stopped'].includes(currentJob.status)) {
    throw new Error(`Cannot requeue follow-up job ${currentJob.jobId} from status ${currentJob.status}`);
  }

  if (currentRound >= maxRounds) {
    return markFollowUpJobStopped({
      rootDir,
      jobPath,
      stoppedAt: requestedAt,
      stopCode,
      stoppedBy: {
        type: 'system',
        requestedBy,
      },
      sourceStatus: currentJob.status,
      stopReason: `Reached max remediation rounds (${currentRound}/${maxRounds}). ${reason}`,
    });
  }

  if (currentJob.status === 'completed' && currentJob?.reReview?.requested !== true) {
    return markFollowUpJobStopped({
      rootDir,
      jobPath,
      stoppedAt: requestedAt,
      stopCode,
      stoppedBy: {
        type: 'system',
        requestedBy,
      },
      sourceStatus: currentJob.status,
      stopReason: `No durable re-review request was recorded for remediation round ${currentRound || 1}; stopping to avoid a silent no-progress loop. ${reason}`,
    });
  }

  const nextJob = {
    ...currentJob,
    status: 'pending',
    pendingAt: requestedAt,
    claimedAt: null,
    claimedBy: null,
    remediationWorker: null,
    failure: null,
    completedAt: null,
    stoppedAt: null,
    completion: null,
    remediationPlan: {
      ...(currentJob.remediationPlan || buildRemediationRoundPlan(maxRounds)),
      stopReason: null,
      nextAction: {
        type: 'consume-pending-round',
        round: currentRound + 1,
        operatorVisibility: 'explicit',
        requestedAt,
        requestedBy,
        reason,
      },
    },
  };

  return moveFollowUpJob(rootDir, jobPath, 'pending', nextJob);
}

function stopFollowUpJob({
  rootDir,
  jobPath,
  requestedAt = new Date().toISOString(),
  requestedBy = 'operator',
  reason = 'Operator requested stop.',
}) {
  const currentJob = readFollowUpJob(jobPath);

  if (currentJob.status === 'stopped') {
    return { job: currentJob, jobPath };
  }

  if (!['pending', 'in_progress', 'completed', 'failed'].includes(currentJob.status)) {
    throw new Error(`Cannot stop follow-up job ${currentJob.jobId} from status ${currentJob.status}`);
  }

  return markFollowUpJobStopped({
    rootDir,
    jobPath,
    stoppedAt: requestedAt,
    stopCode: 'operator-stop',
    stoppedBy: {
      type: 'operator',
      requestedBy,
    },
    sourceStatus: currentJob.status,
    stopReason: reason,
  });
}

export {
  DEFAULT_MAX_REMEDIATION_ROUNDS,
  FOLLOW_UP_JOB_DIRS,
  FOLLOW_UP_JOB_SCHEMA_VERSION,
  LEGACY_DEFAULT_MAX_REMEDIATION_ROUNDS,
  ROUND_BUDGET_BY_RISK_CLASS,
  REMEDIATION_REPLY_KIND,
  REMEDIATION_REPLY_SCHEMA_VERSION,
  buildFollowUpJob,
  buildStopMetadata,
  buildRemediationReply,
  buildRemediationReplyArtifact,
  claimNextFollowUpJob,
  createFollowUpJob,
  ensureFollowUpJobDirs,
  extractReviewSummary,
  getCurrentRound,
  getFollowUpJobDir,
  listFollowUpJobsInDir,
  listInProgressFollowUpJobPaths,
  listInProgressFollowUpJobs,
  listPendingFollowUpJobPaths,
  listPendingFollowUpJobs,
  markFollowUpJobCompleted,
  markFollowUpJobFailed,
  markFollowUpJobSpawned,
  markFollowUpJobStopped,
  readRemediationReplyArtifact,
  salvagePartialRemediationReply,
  readFollowUpJob,
  resolveRoundBudgetForJob,
  requeueFollowUpJobForNextRound,
  stopFollowUpJob,
  summarizePRRemediationLedger,
  validateRemediationReply,
  writeFollowUpJob,
};
