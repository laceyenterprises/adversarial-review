// LIVEPACK-01: flag a PR that edits a running build pack's spec, plan or
// prompts from outside that pack.
//
// SEV3 2026-09-30: a remediation round on a TOC-06 PR rewrote the
// model-efficiency-gym pack's SPEC.md, prompts and plan.json specRef on a
// false "this pack has no DAG runs" claim while dagrun_01M3QXE49Z7RNR5K11ABGVD6ZG
// was running it. Nothing told the reviewer or the remediator the pack was
// live. This module supplies both halves:
//
//   - review gate: every touched `projects/<slug>/{SPEC.md,SPEC.meta.json,
//     plan.json,prompts/**}` whose plan has a non-terminal DAG run in the
//     session ledger, and whose plan tickets do not include this PR's own
//     ticket, becomes a blocking `live_pack_cross_edit` finding. An
//     unreadable ledger or plan is inconclusive and fails closed. The
//     operator waiver is the `live-pack-edit-approved` PR label.
//   - remediation context: the live-run facts for every pack dir the PR
//     touches, rendered into the remediation prompt as trusted data.
//
// Cost is bounded: per touched pack, one plan.json fetch (a second only when
// the pack is absent at the base ref) and one LIMIT-bounded, indexed,
// read-only ledger SELECT.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { execGhWithRetry } from './gh-cli.mjs';
import { fetchRepoFileAtRef } from './pack-lockhash.mjs';
import { parseGhApiArrayPages } from './reviewer-diff-fetch.mjs';
import { parseDiffFiles } from './reviewer-util.mjs';
import {
  LIVE_DAG_RUN_STATES,
  readActiveDagRunsForPlan,
} from './session-ledger-read-adapter.mjs';

const execFileAsync = promisify(execFile);
const PR_FILES_MAX_BUFFER_BYTES = 100 * 1024 * 1024;

const LIVE_PACK_CROSS_EDIT_KIND = 'live_pack_cross_edit';
const LIVE_PACK_EDIT_WAIVER_LABEL = 'live-pack-edit-approved';
const LIVE_PACK_FINDING_HEADING = '## Live Pack Cross-Edit Finding';

const PACK_DIR_RE = /^projects\/([^/]+)\/(.+)$/;
const GUARDED_PACK_FILE_RE = /^(?:SPEC\.md|SPEC\.meta\.json|plan\.json|prompts\/.+)$/;
const TICKET_ID_RE = /^[A-Z][A-Z0-9]*-\d+[A-Z0-9]*$/;
const TITLE_TICKET_RE = /^\s*(?:\[[^\]]*\]\s*)*(?:\([^)]*\)\s*)*(?:SEV\d+\s+)?([A-Za-z][A-Za-z0-9]*-\d+[A-Za-z0-9]*)\b/;

function normalizeText(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function normalizeLabelNames(labels) {
  const names = new Set();
  for (const label of Array.isArray(labels) ? labels : []) {
    const name = typeof label === 'string' ? label : label?.name;
    const normalized = normalizeText(name)?.toLowerCase();
    if (normalized) names.add(normalized);
  }
  return names;
}

function isMissingRepoFileError(err) {
  const text = `${err?.stderr || ''}\n${err?.message || ''}`;
  return /\bHTTP\s+404\b/i.test(text) || /\bnot found\b/i.test(text);
}

function changedPathsFromDiff(diffText) {
  const paths = new Set();
  for (const file of parseDiffFiles(diffText)) {
    for (const path of [file.oldPath, file.newPath, file.path]) {
      if (path && path !== '/dev/null') paths.add(path);
    }
  }
  return [...paths];
}

// Map slug -> sorted touched paths. `guardedOnly` restricts to the files the
// review gate protects (spec, spec meta, plan, prompts); the remediation
// context uses every file under a pack dir.
function touchedPacksFromPaths(paths, { guardedOnly = true } = {}) {
  const packs = new Map();
  for (const rawPath of paths || []) {
    const path = normalizeText(rawPath);
    const match = path ? PACK_DIR_RE.exec(path) : null;
    if (!match) continue;
    const [, slug, rest] = match;
    if (guardedOnly && !GUARDED_PACK_FILE_RE.test(rest)) continue;
    if (!packs.has(slug)) packs.set(slug, new Set());
    packs.get(slug).add(path);
  }
  return new Map(
    [...packs.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([slug, files]) => [slug, [...files].sort()]),
  );
}

// The PR's own ticket ids: the ticket-shaped last branch segment
// (`codex-toc-06/TOC-06`) and the ticket leading the title
// (`[codex] TOC-06: ...`). Deliberately NOT every ticket-shaped token in the
// title: a title that merely mentions another pack's ticket must not exempt
// an edit to that pack.
function extractPrTicketIds({ branch = '', title = '' } = {}) {
  const ids = new Set();
  const lastSegment = String(branch || '').split('/').pop().trim().toUpperCase();
  if (TICKET_ID_RE.test(lastSegment)) ids.add(lastSegment);
  const titleMatch = TITLE_TICKET_RE.exec(String(title || ''));
  if (titleMatch) ids.add(titleMatch[1].toUpperCase());
  return [...ids].sort();
}

function parsePlanJson(text) {
  const plan = JSON.parse(String(text || ''));
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    throw new Error('plan.json is not a JSON object');
  }
  const planId = normalizeText(plan.planId);
  if (!planId) throw new Error('plan.json has no planId');
  const ticketIds = (Array.isArray(plan.tickets) ? plan.tickets : [])
    .map((ticket) => normalizeText(ticket?.id)?.toUpperCase())
    .filter(Boolean);
  return { planId, ticketIds: [...new Set(ticketIds)].sort() };
}

// Resolve a pack's planId and ticket ids. The base ref is authoritative: it
// is the plan the ledger's runs were started from, and a PR cannot exempt
// itself by adding its own ticket to another pack's head plan.json. The head
// is consulted only when the pack does not exist at the base (a new pack).
// Returns { ok: true, planId: null } only when plan.json is absent at both
// refs (not a build pack, conclusively not live).
async function loadPackPlan({
  repo,
  slug,
  baseRef,
  headRef,
  fetchFileAtRefImpl = fetchRepoFileAtRef,
}) {
  const planPath = `projects/${slug}/plan.json`;
  const refs = [...new Set([normalizeText(baseRef), normalizeText(headRef)].filter(Boolean))];
  if (refs.length === 0) {
    return { ok: false, reason: 'plan-ref-unknown', detail: `no base or head ref to read ${planPath}` };
  }
  for (const ref of refs) {
    let text;
    try {
      text = await fetchFileAtRefImpl(repo, planPath, ref);
    } catch (err) {
      if (isMissingRepoFileError(err)) continue;
      return { ok: false, reason: 'plan-read-failed', detail: `${planPath}@${ref}: ${err?.message || err}` };
    }
    try {
      return { ok: true, ...parsePlanJson(text), planRef: ref };
    } catch (err) {
      return { ok: false, reason: 'plan-malformed', detail: `${planPath}@${ref}: ${err?.message || err}` };
    }
  }
  return { ok: true, planId: null, ticketIds: [], planRef: null };
}

function defaultReadActiveDagRuns({ planId, states }) {
  return readActiveDagRunsForPlan({ planId, states });
}

// Liveness of one pack. `live` is true for a conclusive non-terminal run;
// `inconclusive` is true when the plan or the ledger could not be read, and
// callers gating on liveness must treat it as live.
async function resolvePackLiveness({
  repo,
  slug,
  baseRef,
  headRef,
  fetchFileAtRefImpl,
  readActiveDagRunsImpl = defaultReadActiveDagRuns,
}) {
  const plan = await loadPackPlan({ repo, slug, baseRef, headRef, fetchFileAtRefImpl });
  if (!plan.ok) {
    return {
      slug,
      planId: null,
      ticketIds: [],
      runs: [],
      live: false,
      inconclusive: true,
      reason: `${plan.reason}: ${plan.detail}`,
    };
  }
  if (!plan.planId) {
    return { slug, planId: null, ticketIds: [], runs: [], live: false, inconclusive: false, reason: 'no-plan' };
  }
  let result;
  try {
    result = await readActiveDagRunsImpl({ planId: plan.planId, states: LIVE_DAG_RUN_STATES });
  } catch (err) {
    result = { ok: false, reason: 'ledger-read-threw', detail: err?.message || String(err) };
  }
  if (!result?.ok) {
    return {
      slug,
      planId: plan.planId,
      ticketIds: plan.ticketIds,
      runs: [],
      live: false,
      inconclusive: true,
      reason: `ledger unreadable (${result?.reason || 'unknown'}${result?.detail ? `: ${result.detail}` : ''})`,
    };
  }
  const runs = (result.runs || [])
    .map((run) => ({ run_id: normalizeText(run?.run_id), state: normalizeText(run?.state) }))
    .filter((run) => run.run_id);
  return {
    slug,
    planId: plan.planId,
    ticketIds: plan.ticketIds,
    runs,
    live: runs.length > 0,
    inconclusive: false,
    reason: runs.length > 0 ? 'non-terminal-dag-runs' : 'no-non-terminal-dag-runs',
  };
}

function buildLivePackCrossEditFinding({ pack, touchedFiles }) {
  const runIds = pack.runs.map((run) => run.run_id);
  const reason = pack.inconclusive
    ? `live-run check was inconclusive (${pack.reason}); failing closed and treating the pack as live`
    : `pack plan \`${pack.planId}\` has non-terminal DAG run(s): ${pack.runs.map((run) => `${run.run_id} (${run.state})`).join(', ')}`;
  return {
    kind: LIVE_PACK_CROSS_EDIT_KIND,
    severity: 'high',
    blocking: true,
    pack: pack.slug,
    plan_id: pack.planId,
    run_ids: runIds,
    runs: pack.runs,
    touched_files: touchedFiles,
    inconclusive: pack.inconclusive,
    reason,
    detail:
      `This PR edits build pack \`${pack.slug}\` (${touchedFiles.map((file) => `\`${file}\``).join(', ')}) ` +
      `but its ticket is not one of that pack's plan tickets, and ${reason}. ` +
      'Editing a running pack\'s spec, plan or prompts from outside the pack changes the contract its in-flight ' +
      'tickets are being built against. Restore these files to their base-branch content, or have an operator ' +
      `apply the \`${LIVE_PACK_EDIT_WAIVER_LABEL}\` label and re-run review.`,
  };
}

async function evaluateLivePackCrossEdits({
  repo,
  diffText = '',
  changedPaths = null,
  branch = '',
  title = '',
  baseRef = '',
  headRef = '',
  labels = [],
  fetchFileAtRefImpl = fetchRepoFileAtRef,
  readActiveDagRunsImpl = defaultReadActiveDagRuns,
} = {}) {
  const paths = Array.isArray(changedPaths) ? changedPaths : changedPathsFromDiff(diffText);
  const touched = touchedPacksFromPaths(paths, { guardedOnly: true });
  const prTicketIds = extractPrTicketIds({ branch, title });
  const packs = [];
  const candidateFindings = [];
  for (const [slug, touchedFiles] of touched) {
    const pack = await resolvePackLiveness({
      repo, slug, baseRef, headRef, fetchFileAtRefImpl, readActiveDagRunsImpl,
    });
    const ownPack = prTicketIds.some((id) => pack.ticketIds.includes(id));
    packs.push({ ...pack, ownPack, touchedFiles });
    if (ownPack) continue;
    if (pack.live || pack.inconclusive) {
      candidateFindings.push(buildLivePackCrossEditFinding({ pack, touchedFiles }));
    }
  }
  const waived = candidateFindings.length > 0
    && normalizeLabelNames(labels).has(LIVE_PACK_EDIT_WAIVER_LABEL);
  return {
    findings: waived ? [] : candidateFindings,
    waived,
    waivedFindings: waived ? candidateFindings : [],
    prTicketIds,
    packs,
  };
}

// Fail-closed fallback for when evaluation itself throws: every guarded pack
// the diff touches becomes an inconclusive blocking finding unless the waiver
// label is present.
function inconclusiveFindingsForDiff({ diffText = '', changedPaths = null, labels = [], error }) {
  if (normalizeLabelNames(labels).has(LIVE_PACK_EDIT_WAIVER_LABEL)) return [];
  const paths = Array.isArray(changedPaths) ? changedPaths : changedPathsFromDiff(diffText);
  return [...touchedPacksFromPaths(paths, { guardedOnly: true })].map(([slug, touchedFiles]) =>
    buildLivePackCrossEditFinding({
      pack: {
        slug,
        planId: null,
        runs: [],
        inconclusive: true,
        reason: `live-pack evaluation failed: ${error?.message || error}`,
      },
      touchedFiles,
    }),
  );
}

function findingBullet(finding) {
  const runs = finding.runs.length > 0
    ? finding.runs.map((run) => `\`${run.run_id}\` (${run.state})`).join(', ')
    : 'unknown (inconclusive)';
  return `- **[${LIVE_PACK_CROSS_EDIT_KIND}] Cross-pack edit of live build pack \`${finding.pack}\`** — ` +
    `run(s): ${runs}; touched: ${finding.touched_files.map((file) => `\`${file}\``).join(', ')}. ` +
    `${finding.inconclusive ? `The live-run check was inconclusive, so this fails closed: ${finding.reason}. ` : ''}` +
    `Restore these files to their base-branch content (or an operator applies \`${LIVE_PACK_EDIT_WAIVER_LABEL}\`).`;
}

// Split markdown into `## ` sections, ignoring headings inside code fences.
function splitSections(text) {
  const lines = String(text || '').split('\n');
  const sections = [{ heading: null, lines: [] }];
  let fence = null;
  for (const line of lines) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1][0];
      else if (fenceMatch[1][0] === fence) fence = null;
    }
    if (!fence && /^##\s+\S/.test(line) && !/^###/.test(line)) {
      sections.push({ heading: line, lines: [] });
    } else {
      sections[sections.length - 1].lines.push(line);
    }
  }
  return sections;
}

function isNoneLine(line) {
  return /^\s*[-*]?\s*(?:none|n\/a)\.?\s*$/i.test(line);
}

// Inject blocking findings into a review body: a bullet per finding in
// `## Blocking issues` (created if absent), `## Verdict` forced to
// `Request changes`, and a machine-readable JSON block appended. The verdict
// and blocking-count parsers are body-derived, so this is what makes the
// finding gate the merge.
function applyLivePackCrossEditFindings(reviewText, findings) {
  if (!Array.isArray(findings) || findings.length === 0) return reviewText;
  const bullets = findings.map(findingBullet);
  const sections = splitSections(reviewText);
  const blockingIdx = sections.findIndex((s) => /^##\s+Blocking issues\b/i.test(s.heading || ''));
  if (blockingIdx >= 0) {
    const section = sections[blockingIdx];
    const kept = section.lines.filter((line) => !isNoneLine(line));
    while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop();
    const lead = kept.length === 0 || kept[0].trim() !== '' ? [''] : [];
    section.lines = [...lead, ...kept, ...bullets, ''];
  } else {
    const verdictIdxForInsert = sections.findIndex((s) => /^##\s+Verdict\b/i.test(s.heading || ''));
    const newSection = { heading: '## Blocking issues', lines: ['', ...bullets, ''] };
    if (verdictIdxForInsert >= 0) sections.splice(verdictIdxForInsert, 0, newSection);
    else sections.push(newSection);
  }
  const verdictIdx = sections.findIndex((s) => /^##\s+Verdict\b/i.test(s.heading || ''));
  const verdictLines = ['', 'Request changes', ''];
  if (verdictIdx >= 0) sections[verdictIdx].lines = verdictLines;
  else sections.push({ heading: '## Verdict', lines: verdictLines });

  const body = sections
    .map((s) => (s.heading === null ? s.lines.join('\n') : [s.heading, ...s.lines].join('\n')))
    .filter((chunk, idx) => idx > 0 || chunk.length > 0)
    .join('\n')
    .replace(/\s+$/, '');
  return `${body}\n\n${LIVE_PACK_FINDING_HEADING}\n\n\`\`\`json\n${JSON.stringify(findings, null, 2)}\n\`\`\`\n`;
}

function reviewBodyHasLivePackCrossEditFinding(reviewBody) {
  return String(reviewBody || '').includes(LIVE_PACK_FINDING_HEADING);
}

async function listPullRequestFiles(repo, prNumber, {
  execGhWithRetryImpl = execGhWithRetry,
  execFileImpl = execFileAsync,
} = {}) {
  const { stdout } = await execGhWithRetryImpl({
    execFileImpl: async (command, args, options) => execFileImpl(
      command,
      args,
      { ...options, maxBuffer: PR_FILES_MAX_BUFFER_BYTES },
    ),
    args: ['api', '--method', 'GET', '--paginate', `repos/${repo}/pulls/${prNumber}/files`, '-f', 'per_page=100'],
  });
  const paths = new Set();
  for (const file of parseGhApiArrayPages(stdout)) {
    for (const path of [file?.filename, file?.previous_filename]) {
      if (normalizeText(path)) paths.add(path);
    }
  }
  return [...paths];
}

const REMEDIATION_RULE =
  'Do not edit another live pack\'s spec, plan or prompts; if the fix seems to need it, stop and report ' +
  '(record a `blockers[]` entry naming the pack and run id, and set `reReview.requested = false`).';

function formatLivePackRemediationContext({ packs = [], error = null } = {}) {
  if (error) {
    return `

## Trusted Live Build Pack Facts
The orchestrator could not determine which build packs this PR touches are running (${error}). Treat every build pack under \`projects/\` as live.
- ${REMEDIATION_RULE}
- Restoring a pack file this PR changed to its exact \`origin/<base>\` content is allowed; it removes the cross-edit instead of making one.
- Never apply the \`${LIVE_PACK_EDIT_WAIVER_LABEL}\` label yourself; it is an operator waiver.
`;
  }
  if (packs.length === 0) return '';
  const facts = packs.map((pack) => ({
    slug: pack.slug,
    planId: pack.planId,
    ownPack: pack.ownPack,
    live: pack.live || pack.inconclusive,
    liveCheckInconclusive: pack.inconclusive,
    runs: pack.runs.map((run) => ({ runId: run.run_id, state: run.state })),
    touchedFiles: pack.touchedFiles,
  }));
  const fence = '```';
  return `

## Trusted Live Build Pack Facts
This PR touches the build pack directories below. The session ledger was read by the orchestrator, not the reviewer; a pack whose live check was inconclusive is treated as live (fail closed).
${fence}json
${JSON.stringify(facts, null, 2)}
${fence}
- ${REMEDIATION_RULE}
- A pack is "another" pack when \`ownPack\` is false. Only its \`SPEC.md\`, \`SPEC.meta.json\`, \`plan.json\` and \`prompts/**\` are protected; do not re-stamp its specRef either.
- A \`${LIVE_PACK_CROSS_EDIT_KIND}\` finding is addressed by restoring the listed files to their exact \`origin/<base>\` content; that removes the cross-edit instead of making one.
- Never apply the \`${LIVE_PACK_EDIT_WAIVER_LABEL}\` label yourself; it is an operator waiver.
`;
}

// Remediation-side resolver. Lists the PR's files via the GitHub API (the
// hq-dispatch path has no local checkout), then reads liveness for every pack
// dir touched. Any failure renders the fail-closed caution block.
async function resolveLivePackRemediationContext({
  repo,
  prNumber,
  baseBranch,
  headRef = '',
  branch = '',
  title = '',
  listPrFilesImpl = listPullRequestFiles,
  loadPrTitleImpl = null,
  fetchFileAtRefImpl = fetchRepoFileAtRef,
  readActiveDagRunsImpl = defaultReadActiveDagRuns,
} = {}) {
  try {
    const paths = await listPrFilesImpl(repo, prNumber);
    const touched = touchedPacksFromPaths(paths, { guardedOnly: false });
    if (touched.size === 0) return '';
    // Existing durable jobs have no PR title. Resolve it only for pack
    // edits, and let a failed metadata read render the fail-closed block.
    if (!title && loadPrTitleImpl) title = await loadPrTitleImpl(repo, prNumber);
    const prTicketIds = extractPrTicketIds({ branch, title });
    const packs = [];
    for (const [slug, touchedFiles] of touched) {
      const pack = await resolvePackLiveness({
        repo,
        slug,
        baseRef: baseBranch,
        headRef: headRef || branch,
        fetchFileAtRefImpl,
        readActiveDagRunsImpl,
      });
      if (!pack.planId && !pack.inconclusive) continue;
      packs.push({ ...pack, ownPack: prTicketIds.some((id) => pack.ticketIds.includes(id)), touchedFiles });
    }
    return formatLivePackRemediationContext({ packs });
  } catch (err) {
    return formatLivePackRemediationContext({ error: err?.message || String(err) });
  }
}

// Reviewer entry point: evaluate the PR and inject any blocking findings into
// the review text before the comment body is built. Unlike the additive-only
// scope violation, the finding does not suppress follow-up remediation: the
// remediator is told which packs are live and reverts or stops. Any failure
// fails closed (inconclusive finding) rather than passing the edit through.
async function applyLivePackCrossEditReview(reviewText, {
  repo,
  prNumber,
  diff = '',
  prContext = null,
  labels = [],
  reviewerHeadSha = null,
  log = console,
  evaluateImpl = evaluateLivePackCrossEdits,
} = {}) {
  // Only the posting-time read can authorize a waiver. PR context and
  // dispatch labels may predate an operator's removal during model review.
  const currentLabels = Array.isArray(labels) ? labels : [];
  let findings;
  try {
    const review = await evaluateImpl({
      repo,
      diffText: diff,
      branch: prContext?.headRefName || '',
      title: prContext?.title || '',
      baseRef: prContext?.baseRefName || '',
      headRef: reviewerHeadSha || prContext?.headRefOid || '',
      labels: currentLabels,
    });
    findings = review.findings;
    if (review.waived) {
      log?.error?.(
        `[reviewer] live-pack cross-edit waived by ${LIVE_PACK_EDIT_WAIVER_LABEL} for ${repo}#${prNumber}: ` +
          review.waivedFindings.map((finding) => finding.pack).join(', '),
      );
    }
  } catch (err) {
    findings = inconclusiveFindingsForDiff({ diffText: diff, labels: currentLabels, error: err });
    log?.error?.(
      `[reviewer] WARN: live-pack cross-edit check failed for ${repo}#${prNumber}; failing closed: ${err?.message || err}`,
    );
  }
  for (const finding of findings) {
    log?.error?.(
      `[reviewer] live-pack cross-edit detected for ${repo}#${prNumber}: pack=${finding.pack} ` +
        `runs=${finding.run_ids.join(',') || '<inconclusive>'} files=${finding.touched_files.join(', ')}`,
    );
  }
  return applyLivePackCrossEditFindings(reviewText, findings);
}

// Remediation entry point for a follow-up job. `execFileImpl` is threaded to
// every gh call so the consumer's injected runner (and its tests) own I/O.
function resolveLivePackContextForJob({ job, execFileImpl = execFileAsync, readActiveDagRunsImpl = defaultReadActiveDagRuns } = {}) {
  return resolveLivePackRemediationContext({
    repo: job?.repo,
    prNumber: job?.prNumber,
    baseBranch: job?.baseBranch,
    headRef: job?.revisionRef || job?.branch || '',
    branch: job?.branch || '',
    title: job?.prTitle || job?.title || '',
    readActiveDagRunsImpl,
    listPrFilesImpl: (repo, prNumber) => listPullRequestFiles(repo, prNumber, { execFileImpl }),
    loadPrTitleImpl: async (repo, prNumber) => {
      const { stdout } = await execGhWithRetry({
        execFileImpl,
        args: ['api', `repos/${repo}/pulls/${prNumber}`],
      });
      const title = normalizeText(JSON.parse(String(stdout)).title);
      if (!title) throw new Error('PR metadata has no title');
      return title;
    },
    fetchFileAtRefImpl: (repo, path, ref) => fetchRepoFileAtRef(repo, path, ref, { execFileImpl }),
  });
}

export {
  LIVE_PACK_CROSS_EDIT_KIND,
  LIVE_PACK_EDIT_WAIVER_LABEL,
  LIVE_PACK_FINDING_HEADING,
  applyLivePackCrossEditFindings,
  applyLivePackCrossEditReview,
  buildLivePackCrossEditFinding,
  changedPathsFromDiff,
  evaluateLivePackCrossEdits,
  extractPrTicketIds,
  formatLivePackRemediationContext,
  inconclusiveFindingsForDiff,
  listPullRequestFiles,
  loadPackPlan,
  resolveLivePackContextForJob,
  resolveLivePackRemediationContext,
  resolvePackLiveness,
  reviewBodyHasLivePackCrossEditFinding,
  touchedPacksFromPaths,
};
