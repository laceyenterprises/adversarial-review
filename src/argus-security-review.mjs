// ARGUSDRAIN-01 — review ONE Argus security job and say what the drain must do.
//
// ASR shipped the classifier, the queue, the route, the rubric and the gate, but
// not the consumer that turns a queued job into a verdict: `claimNextArgusJob`
// had no production caller, 1,519 jobs sat unclaimed, and every semver-major
// Dependabot bump parked forever (SEV3 2026-09-29, agent-os#7326). The drain
// (`argus-security-drain.mjs`) claims jobs; this module reviews one:
//
//   1. LIVENESS FIRST. The PR is read live from GitHub. A merged or closed PR,
//      or a head that moved on, is not a security question anymore: the job
//      closes `superseded` and nothing is reviewed or posted.
//   2. EVIDENCE. The PR diff, plus whatever the injected evidence gatherers
//      produce (the deterministic ASR-05 rubric over the materialised trees, the
//      dependency-bump evidence, the head's CI result).
//   3. A REVIEWER MODEL reads the rubric prompt and the evidence, through the
//      same harness the adversarial reviewer uses (so the same OAuth, broker and
//      credential-pool handling), trying each available model in turn.
//   4. THE VERDICT IS COMPOSED HERE, never taken from the model. `high` is
//      reserved to the rubric's six categories; a `high` outside them is
//      demoted, and only a surviving `high` blocks.
//   5. FINDINGS ARE POSTED before the verdict is recorded. A `blocked` verdict
//      that could not post its finding is not recorded; the drain retries the
//      post without re-running the model.
//
// It never touches the queue. It returns an outcome and the drain applies it,
// which keeps every bucket transition in one place.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defangUntrustedMarkdown } from './adapters/comms/github-pr-comments/pr-comments.mjs';
import { redactSensitiveText } from './adapters/comms/github-pr-comments/redaction.mjs';
import { ARGUS_SUPERSEDED_VERDICT, ARGUS_VERDICTS } from './argus-security-verdict.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const ARGUS_REVIEW_OUTCOME = Object.freeze({
  COMPLETE: 'complete',
  DEFER: 'defer',
  RETRY: 'retry',
});

export const ARGUS_REVIEW_RESULT_SOURCE = 'argus-security-drain';
export const ARGUS_REVIEW_COMMENT_MARKER = 'argus-security-review';

// The rubric's reserved-high set (`severity.py` RESERVED_HIGH_CATEGORIES in
// agent-os). The only findings that may block.
export const ARGUS_RESERVED_HIGH_CATEGORIES = Object.freeze(new Set([
  'install_time_execution',
  'unpinned_source',
  'non_registry_source',
  'missing_integrity',
  'typosquat_shaped_name',
  'credential_surface',
]));

// `version_distance` is capped at `low` by the rubric: "major bump = risky" is
// the naive rule that inverts the correct reading of adversarial-review#909.
const MAX_SEVERITY_BY_CATEGORY = Object.freeze({ version_distance: 'low' });
const SEVERITY_RANK = Object.freeze({ low: 1, medium: 2, high: 3 });

// A cached model review is reused while the drain waits on CI for the same
// head, so a slow suite does not buy a second model call. Past this age the
// evidence is re-read.
export const ARGUS_CACHED_REVIEW_MAX_AGE_MS = 6 * 60 * 60 * 1000;

// The prompt travels on argv for the agy runtime (262,144-byte budget), so the
// diff is capped well below it. Lockfile hunks are trimmed first: the lockfile
// facts reach the reviewer as structured evidence instead.
const MAX_PROMPT_DIFF_BYTES = 150_000;
const MAX_LOCKFILE_HUNK_LINES = 300;
const LOCKFILE_NAMES = Object.freeze(new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml',
  'poetry.lock', 'Pipfile.lock', 'Cargo.lock', 'go.sum',
]));
const MAX_COMMENT_CHARS = 60_000;

let promptTemplateCache = null;
export function loadArgusReviewPromptTemplate(rootDir = ROOT) {
  if (rootDir === ROOT && promptTemplateCache) return promptTemplateCache;
  const text = readFileSync(join(rootDir, 'prompts', 'argus-security', 'reviewer.md'), 'utf8');
  if (rootDir === ROOT) promptTemplateCache = text;
  return text;
}

function normalizeCategory(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[\s-]+/gu, '_') || 'unspecified';
}

function normalizeSeverity(value) {
  const severity = String(value ?? '').trim().toLowerCase();
  return SEVERITY_RANK[severity] ? severity : 'low';
}

function boundedText(value, max = 2000) {
  const text = String(value ?? '').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Normalise one finding and apply the severity taxonomy. `high` outside the
 * reserved set is demoted to `medium` and says so (`demotedFrom`), mirroring
 * the rubric's `SeverityBoundaryError` without failing the whole review over a
 * model's over-reach.
 */
export function normalizeArgusFinding(raw, { source = 'model' } = {}) {
  const category = normalizeCategory(raw?.category);
  let severity = normalizeSeverity(raw?.severity);
  let demotedFrom = null;
  if (severity === 'high' && !ARGUS_RESERVED_HIGH_CATEGORIES.has(category)) {
    demotedFrom = 'high';
    severity = 'medium';
  }
  const cap = MAX_SEVERITY_BY_CATEGORY[category];
  if (cap && SEVERITY_RANK[severity] > SEVERITY_RANK[cap]) {
    demotedFrom ||= severity;
    severity = cap;
  }
  return {
    category,
    severity,
    title: boundedText(raw?.title || raw?.summary || category, 200),
    detail: boundedText(raw?.detail ?? raw?.evidence ?? raw?.message ?? ''),
    path: raw?.path ? String(raw.path) : null,
    source,
    ...(demotedFrom ? { demotedFrom } : {}),
  };
}

const JSON_BLOCK_PATTERN = /<argus-review-json>\s*([\s\S]*?)\s*<\/argus-review-json>/iu;

/**
 * Parse the reviewer's output. Throws on anything that is not the contract, so
 * the caller can try the next model: an unparseable review is not a review.
 */
export function parseArgusReviewOutput(text) {
  const raw = String(text ?? '');
  const match = raw.match(JSON_BLOCK_PATTERN);
  if (!match) throw new Error('reviewer output has no <argus-review-json> block');
  const body = match[1].replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '');
  let doc;
  try {
    doc = JSON.parse(body);
  } catch (err) {
    throw new Error(`reviewer <argus-review-json> block is not JSON: ${err.message}`);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('reviewer <argus-review-json> block is not an object');
  }
  const verdict = String(doc.verdict ?? '').trim().toLowerCase();
  if (![ARGUS_VERDICTS.APPROVE, ARGUS_VERDICTS.BLOCK, ARGUS_VERDICTS.NEEDS_VERIFICATION].includes(verdict)) {
    throw new Error(`reviewer verdict ${JSON.stringify(doc.verdict)} is not approve/block/needs_verification`);
  }
  if (!Array.isArray(doc.findings)) throw new Error('reviewer findings is not an array');
  return {
    verdict,
    summary: boundedText(doc.summary, 600),
    riskDirection: ['reduced', 'unchanged', 'increased'].includes(doc.riskDirection) ? doc.riskDirection : null,
    findings: doc.findings.map((finding) => normalizeArgusFinding(finding, { source: 'model' })),
    axes: Array.isArray(doc.axes) ? doc.axes.slice(0, 16).map((axis) => ({
      axis: boundedText(axis?.axis, 80),
      status: boundedText(axis?.status, 40),
      note: boundedText(axis?.note, 400),
    })) : [],
    breakingChanges: Array.isArray(doc.breakingChanges)
      ? doc.breakingChanges.slice(0, 20).map((item) => boundedText(item, 400))
      : [],
  };
}

/**
 * Compose the verdict from evidence. Pure.
 *
 * - Any `high` (after the taxonomy) → `block`. That is the only way to block.
 * - Else, when verification is required and not satisfied → `needs_verification`.
 * - Else → `approve`.
 *
 * The model's own verdict string is advisory: a model that says `block`
 * without a reserved-category `high` does not block, and a model that says
 * `approve` over a `high` does not approve.
 */
export function composeArgusVerdict({ modelReview, rubricFindings = [], verification = null }) {
  const findings = [...rubricFindings, ...(modelReview?.findings || [])];
  const blocking = findings.filter((finding) => finding.severity === 'high');
  const advisory = findings.filter((finding) => finding.severity !== 'high');
  if (blocking.length > 0) {
    return {
      verdict: ARGUS_VERDICTS.BLOCK,
      summary: `Argus found ${blocking.length} high-severity finding${blocking.length === 1 ? '' : 's'}: `
        + blocking.map((finding) => finding.title).join('; '),
      findings,
      blocking,
      advisory,
    };
  }
  if (verification?.required && !verification.satisfied) {
    return {
      verdict: ARGUS_VERDICTS.NEEDS_VERIFICATION,
      summary: `Argus needs verification: ${verification.detail || 'required evidence is missing'}.`,
      findings,
      blocking,
      advisory,
    };
  }
  return {
    verdict: ARGUS_VERDICTS.APPROVE,
    summary: modelReview?.summary || 'Argus found no high-severity finding.',
    findings,
    blocking,
    advisory,
  };
}

function diffFileName(headerLine) {
  const match = String(headerLine).match(/^diff --git a\/(.+?) b\/(.+)$/u);
  return match ? match[2] : '';
}

/**
 * Trim a PR diff for the prompt: lockfile hunks are cut to a head, then the
 * whole diff is capped. Both cuts are announced in the text, so the reviewer
 * knows what it did not see.
 */
export function trimDiffForArgusPrompt(diff, { maxBytes = MAX_PROMPT_DIFF_BYTES } = {}) {
  const text = String(diff ?? '');
  const sections = text.split(/^(?=diff --git )/mu);
  const trimmed = sections.map((section) => {
    const name = diffFileName(section.split('\n', 1)[0]);
    const base = name.split('/').pop();
    if (!LOCKFILE_NAMES.has(base)) return section;
    const lines = section.split('\n');
    if (lines.length <= MAX_LOCKFILE_HUNK_LINES) return section;
    return `${lines.slice(0, MAX_LOCKFILE_HUNK_LINES).join('\n')}\n`
      + `[argus: ${lines.length - MAX_LOCKFILE_HUNK_LINES} more lockfile diff lines omitted; `
      + 'the lockfile facts are in the evidence section]\n';
  }).join('');
  if (Buffer.byteLength(trimmed, 'utf8') <= maxBytes) return trimmed;
  const cut = Buffer.from(trimmed, 'utf8').subarray(0, maxBytes).toString('utf8');
  return `${cut}\n[argus: diff truncated at ${maxBytes} bytes; review what is shown and say what you could not see]\n`;
}

export function buildArgusReviewPrompt({ promptTemplate, job, pr, diff, evidence = [] }) {
  const reasons = (Array.isArray(job?.reasons) ? job.reasons : [])
    .map((reason) => `- ${reason?.trigger || 'unknown'}${reason?.matches ? `: ${reason.matches.map((m) => m?.path).filter(Boolean).slice(0, 20).join(', ')}` : ''}`)
    .join('\n');
  const evidenceText = evidence
    .filter((section) => section && section.body)
    .map((section) => `### ${section.title}\n\n${section.body}`)
    .join('\n\n');
  return [
    promptTemplate.trim(),
    '',
    '---',
    '',
    '## The job',
    '',
    `- Repository: ${job.repo}`,
    `- Pull request: #${job.prNumber} — ${pr?.title || '(no title)'}`,
    `- Author: ${pr?.author || 'unknown'}`,
    `- Base: ${pr?.baseSha || 'unknown'}  Head: ${job.headSha}`,
    '- Why Argus was asked:',
    reasons || '- (no trigger recorded)',
    '',
    evidenceText ? `## Evidence\n\n${evidenceText}\n` : '## Evidence\n\n(none beyond the diff)\n',
    '## The diff',
    '',
    '```diff',
    trimDiffForArgusPrompt(diff),
    '```',
  ].join('\n');
}

function renderFinding(finding) {
  const safe = (text) => defangUntrustedMarkdown(redactSensitiveText(text));
  const where = finding.path ? ` (${safe(finding.path)})` : '';
  const demoted = finding.demotedFrom
    ? ` — demoted from \`${finding.demotedFrom}\`: \`${finding.category}\` is not a reserved-high category`
    : '';
  const detail = finding.detail ? `\n  ${safe(finding.detail).replace(/\n/gu, '\n  ')}` : '';
  return `- **[${finding.severity}]** \`${finding.category}\` — ${safe(finding.title)}${where}${demoted}${detail}`;
}

/**
 * The PR comment. Model-written text is redacted and defanged: the reviewer is
 * an untrusted output source, and a finding must not be able to @-mention,
 * autolink, or inject markdown into a public comment.
 */
export function buildArgusFindingsComment({ job, result }) {
  const verdictLabel = {
    [ARGUS_VERDICTS.APPROVE]: 'approved',
    [ARGUS_VERDICTS.BLOCK]: 'blocked',
    [ARGUS_VERDICTS.NEEDS_VERIFICATION]: 'needs verification',
  }[result.verdict] || result.verdict;
  const blocking = result.findings.filter((finding) => finding.severity === 'high');
  const advisory = result.findings.filter((finding) => finding.severity !== 'high');
  const lines = [
    `<!-- ${ARGUS_REVIEW_COMMENT_MARKER} job=${job.jobId} head=${job.headSha} verdict=${result.verdict} -->`,
    '## Argus security review',
    '',
    `**Verdict: ${verdictLabel}** for head \`${job.headSha.slice(0, 12)}\`.`,
    '',
    defangUntrustedMarkdown(redactSensitiveText(result.summary)),
    '',
  ];
  if (blocking.length > 0) {
    lines.push('### Blocking (high)', '', ...blocking.map(renderFinding), '');
  }
  if (advisory.length > 0) {
    lines.push('### Advisory (medium / low, never blocks)', '', ...advisory.map(renderFinding), '');
  }
  if (result.verification?.required) {
    lines.push(
      '### Verification',
      '',
      `${result.verification.satisfied ? 'Satisfied' : 'Not satisfied'}: ${defangUntrustedMarkdown(result.verification.detail || '')}`,
      '',
    );
  }
  lines.push(
    `<sub>Reviewed by ${result.reviewer?.model || 'unknown'} under the ASR-05 rubric. `
      + 'Only `high` findings in a reserved category block; `medium` and `low` are advisory. '
      + 'Scoped `operator-approved` remains the escape hatch.</sub>',
  );
  const body = lines.join('\n');
  return body.length > MAX_COMMENT_CHARS ? `${body.slice(0, MAX_COMMENT_CHARS)}\n…(truncated)` : body;
}

function isArgusOwnedJob(job) {
  return (Array.isArray(job?.reasons) ? job.reasons : []).some((reason) => reason?.trigger === 'bot-author');
}

/**
 * Post when the comment carries information: any finding, any verdict other
 * than a clean approval, or a PR Argus owns outright (a bot PR has no other
 * reviewer to explain why it merged). A clean additive approval on a routable
 * PR posts nothing, so the security lane does not bury every agent PR in
 * "no findings" comments.
 */
export function shouldPostArgusComment({ job, result }) {
  if (result.verdict === ARGUS_SUPERSEDED_VERDICT) return false;
  if (result.findings.length > 0) return true;
  if (result.verdict !== ARGUS_VERDICTS.APPROVE) return true;
  return isArgusOwnedJob(job);
}

function supersededOutcome({ pr, nowIso }) {
  const state = String(pr?.state || '').toUpperCase();
  const reason = state === 'MERGED'
    ? 'pr-merged'
    : state === 'CLOSED'
      ? 'pr-closed'
      : 'head-superseded';
  return {
    kind: ARGUS_REVIEW_OUTCOME.COMPLETE,
    result: {
      schemaVersion: 1,
      kind: 'argus-security-result',
      source: ARGUS_REVIEW_RESULT_SOURCE,
      verdict: ARGUS_SUPERSEDED_VERDICT,
      summary: `Argus closed this job without a review: ${reason}.`,
      supersededReason: reason,
      observedState: state || null,
      observedHeadSha: pr?.headSha || null,
      retiredBy: 'claim-time-liveness',
      findings: [],
      completedAt: nowIso,
    },
  };
}

function cachedReviewFor(job, nowMs) {
  const cached = job?.drain?.cachedReview;
  if (!cached || cached.headSha !== job.headSha) return null;
  const reviewedMs = Date.parse(cached.reviewedAt || '');
  if (!Number.isFinite(reviewedMs) || nowMs - reviewedMs > ARGUS_CACHED_REVIEW_MAX_AGE_MS) return null;
  return cached;
}

async function runModels({ models, prompt, cwd, diff, runReviewerModel, logger }) {
  const attempts = [];
  for (const model of models) {
    try {
      // `diff` only sizes the harness's timeout budget; the prompt is complete.
      const output = await runReviewerModel({ model, prompt, cwd, diff });
      const review = parseArgusReviewOutput(output?.text);
      return { review, model, execution: output?.execution || null, attempts };
    } catch (err) {
      const message = String(err?.message || err).slice(0, 500);
      attempts.push({ model, error: message });
      logger?.warn?.(`[argus-review] ${model} did not produce a review: ${message}`);
    }
  }
  return { review: null, model: null, execution: null, attempts };
}

/**
 * Review one claimed job.
 *
 * @param {object} opts
 * @param {object} opts.job        the claimed job record.
 * @param {object} opts.deps       injected I/O (see `createDefaultArgusReviewDeps`).
 * @returns {Promise<{kind: 'complete'|'defer'|'retry', result?: object,
 *   reason?: string, retryAfterMs?: number, error?: string, cachedReview?: object}>}
 */
export async function reviewArgusJob({
  job,
  deps,
  workDir,
  nowMs = Date.now(),
  logger = console,
  promptTemplate = null,
} = {}) {
  const nowIso = new Date(nowMs).toISOString();
  let pr;
  try {
    pr = await deps.fetchPullRequest({ repo: job.repo, prNumber: job.prNumber });
  } catch (err) {
    return { kind: ARGUS_REVIEW_OUTCOME.RETRY, error: `live PR read failed: ${err?.message || err}` };
  }
  if (String(pr?.state || '').toUpperCase() !== 'OPEN' || String(pr?.headSha || '').toLowerCase() !== job.headSha) {
    return supersededOutcome({ pr, nowIso });
  }

  let cached = cachedReviewFor(job, nowMs);
  let evidence = null;
  if (!cached) {
    let diff;
    try {
      diff = await deps.fetchDiff({ repo: job.repo, prNumber: job.prNumber, headSha: job.headSha });
    } catch (err) {
      return { kind: ARGUS_REVIEW_OUTCOME.RETRY, error: `PR diff read failed: ${err?.message || err}` };
    }
    evidence = typeof deps.gatherEvidence === 'function'
      ? await deps.gatherEvidence({ job, pr, diff, workDir })
      : { sections: [], rubricFindings: [], rubric: null, dependency: null };
    if (evidence.fatal) {
      // The deterministic rubric ran and crashed. Its `high` findings are the
      // authoritative ones, so the review is not decided without it.
      return { kind: ARGUS_REVIEW_OUTCOME.RETRY, error: evidence.fatal };
    }
    const models = await deps.resolveReviewerModels({ job, pr });
    if (!Array.isArray(models) || models.length === 0) {
      return {
        kind: ARGUS_REVIEW_OUTCOME.DEFER,
        reason: 'no-reviewer-model-available',
        retryAfterMs: 15 * 60 * 1000,
      };
    }
    const prompt = buildArgusReviewPrompt({
      promptTemplate: promptTemplate || loadArgusReviewPromptTemplate(),
      job,
      pr,
      diff,
      evidence: evidence.sections,
    });
    const ran = await runModels({ models, prompt, cwd: workDir, diff, runReviewerModel: deps.runReviewerModel, logger });
    if (!ran.review) {
      return {
        kind: ARGUS_REVIEW_OUTCOME.RETRY,
        error: `no reviewer model produced a review: ${ran.attempts.map((a) => `${a.model}: ${a.error}`).join(' | ')}`,
      };
    }
    cached = {
      headSha: job.headSha,
      reviewedAt: nowIso,
      model: ran.model,
      execution: ran.execution,
      modelAttempts: ran.attempts,
      modelReview: ran.review,
      rubricFindings: evidence.rubricFindings || [],
      rubric: evidence.rubric || null,
      dependency: evidence.dependency || null,
    };
  }

  const verification = typeof deps.assessVerification === 'function'
    ? deps.assessVerification({ job, pr, cached, nowMs })
    : null;
  if (verification?.defer) {
    return {
      kind: ARGUS_REVIEW_OUTCOME.DEFER,
      reason: verification.reason || 'verification-pending',
      retryAfterMs: verification.retryAfterMs || 10 * 60 * 1000,
      cachedReview: cached,
    };
  }

  const composed = composeArgusVerdict({
    modelReview: cached.modelReview,
    rubricFindings: cached.rubricFindings,
    verification,
  });
  const result = {
    schemaVersion: 1,
    kind: 'argus-security-result',
    source: ARGUS_REVIEW_RESULT_SOURCE,
    verdict: composed.verdict,
    summary: composed.summary,
    findings: composed.findings,
    riskDirection: cached.modelReview.riskDirection,
    axes: cached.modelReview.axes,
    breakingChanges: cached.modelReview.breakingChanges,
    modelVerdict: cached.modelReview.verdict,
    triggerReasons: (job.reasons || []).map((reason) => reason?.trigger).filter(Boolean),
    reviewer: { model: cached.model, execution: cached.execution, attempts: cached.modelAttempts || [] },
    rubric: cached.rubric,
    dependency: cached.dependency,
    verification: verification
      ? { required: Boolean(verification.required), satisfied: Boolean(verification.satisfied), detail: verification.detail || null, source: verification.source || null }
      : null,
    completedAt: nowIso,
    posted: null,
  };

  if (shouldPostArgusComment({ job, result })) {
    const body = buildArgusFindingsComment({ job, result });
    let posted;
    try {
      posted = await deps.postComment({ repo: job.repo, prNumber: job.prNumber, body, model: cached.model });
    } catch (err) {
      posted = { ok: false, error: String(err?.message || err) };
    }
    result.posted = posted;
    if (!posted?.ok && result.verdict === ARGUS_VERDICTS.BLOCK) {
      // A block with no posted finding is a red check nobody can act on. Hold
      // the verdict and retry the post; the cached review means the retry does
      // not buy a second model call.
      return {
        kind: ARGUS_REVIEW_OUTCOME.RETRY,
        error: `blocking finding could not be posted: ${posted?.error || posted?.reason || 'unknown'}`,
        cachedReview: cached,
      };
    }
  }

  return { kind: ARGUS_REVIEW_OUTCOME.COMPLETE, result };
}
