import { execFile as execFileCallback } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { fetchPullRequestRollup } from './github-api.mjs';
import { duplicateFamilyCandidateRows } from './duplicate-family-state.mjs';
import { openReviewStateDb } from './review-state.mjs';

const execFileDefault = promisify(execFileCallback);
const GIT_MAX_ATTEMPTS = 3;
const GIT_RETRY_BACKOFF_MS = 50;

class DuplicateFamilyPacketError extends Error {
  constructor(message, { code, details = {} } = {}) {
    super(message);
    this.name = 'DuplicateFamilyPacketError';
    this.code = code || 'duplicate-family-packet-error';
    this.details = details;
  }
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function stableJson(value) {
  return `${JSON.stringify(sortForJson(value), null, 2)}\n`;
}

function sortForJson(value) {
  if (Array.isArray(value)) return value.map(sortForJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sortForJson(value[key])])
  );
}

function shortSha(value) {
  const text = String(value || '').trim();
  return text ? text.slice(0, 12) : '';
}

function prUrl(repo, prNumber) {
  return `https://github.com/${repo}/pull/${prNumber}`;
}

function normalizeCheck(check) {
  return {
    name: check?.name || check?.context || 'unknown-check',
    conclusion: check?.conclusion || check?.state || check?.status || null,
    completedAt: check?.completedAt || check?.completed_at || check?.createdAt || null,
  };
}

function latestItems(items, dateField, limit = 5) {
  return [...(Array.isArray(items) ? items : [])]
    .sort((left, right) => String(right?.[dateField] || '').localeCompare(String(left?.[dateField] || '')))
    .slice(0, limit);
}

function reviewHasUnresolvedFinding(review) {
  const state = String(review?.state || '').toUpperCase();
  const body = String(review?.body || '');
  return state === 'CHANGES_REQUESTED'
    || /##\s+Verdict\s*\n\s*Request changes/i.test(body);
}

function relevantComments(comments) {
  return (Array.isArray(comments) ? comments : []).filter((comment) => (
    /\b(duplicate|divergence|survivor|loser|adjudicat|finding|request changes|blocked|merge)\b/i
      .test(`${comment?.body || ''}`)
  ));
}

function sleep(ms) {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}

function isTransientGitError(err) {
  const text = [
    err?.code,
    err?.signal,
    err?.message,
    err?.stderr,
    err?.stdout,
  ].filter(Boolean).join('\n');
  return /\b(ETIMEDOUT|EAGAIN|EBUSY|EIO)\b/i.test(text)
    || /timed?\s*out/i.test(text)
    || /resource temporarily unavailable/i.test(text)
    || /index\.lock|could not lock/i.test(text);
}

async function git(repoDir, args, { execFileImpl = execFileDefault, allowFailure = false } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= GIT_MAX_ATTEMPTS; attempt += 1) {
    try {
      const result = await execFileImpl('git', ['-C', repoDir, ...args], {
        maxBuffer: 20 * 1024 * 1024,
        timeout: 30_000,
      });
      return String(result.stdout || '').trimEnd();
    } catch (err) {
      lastError = err;
      if (!isTransientGitError(err) || attempt === GIT_MAX_ATTEMPTS) {
        if (allowFailure) {
          return null;
        }
        throw err;
      }
      await sleep(GIT_RETRY_BACKOFF_MS * attempt);
    }
  }
  if (allowFailure) {
    return null;
  }
  throw lastError;
}

async function objectExists(repoDir, objectName, deps) {
  if (!objectName) return false;
  const result = await git(repoDir, ['cat-file', '-e', `${objectName}^{commit}`], {
    ...deps,
    allowFailure: true,
  });
  return result !== null;
}

async function fetchPullHead(repoDir, prNumber, deps) {
  if (!prNumber) return false;
  const result = await git(
    repoDir,
    ['fetch', '--no-tags', 'origin', `pull/${prNumber}/head`],
    { ...deps, allowFailure: true }
  );
  return result !== null;
}

async function ensureCandidateObject(repoDir, candidate, deps) {
  if (!candidate.headSha) return false;
  if (await objectExists(repoDir, candidate.headSha, deps)) {
    return true;
  }
  await fetchPullHead(repoDir, candidate.prNumber, deps);
  return objectExists(repoDir, candidate.headSha, deps);
}

async function resolveRef(repoDir, ref, deps) {
  if (!ref) return null;
  const out = await git(repoDir, ['rev-parse', '--verify', `${ref}^{commit}`], {
    ...deps,
    allowFailure: true,
  });
  return out || null;
}

async function resolveBaseRef(repoDir, candidate, deps) {
  const refs = [
    candidate.baseBranch,
    `origin/${candidate.baseBranch}`,
    `refs/remotes/origin/${candidate.baseBranch}`,
    `refs/heads/${candidate.baseBranch}`,
  ].filter(Boolean);
  for (const ref of refs) {
    const sha = await resolveRef(repoDir, ref, deps);
    if (sha) return { ref, sha };
  }
  if (candidate.baseSha && await objectExists(repoDir, candidate.baseSha, deps)) {
    return { ref: candidate.baseSha, sha: candidate.baseSha };
  }
  return { ref: null, sha: null };
}

function rowToCandidate(row) {
  return {
    repo: row.repo,
    prNumber: Number(row.pr_number),
    title: row.title || '',
    prState: row.pr_state || null,
    baseBranch: row.base_branch || 'main',
    headBranch: row.head_branch || null,
    headSha: row.head_sha || null,
    baseSha: row.base_sha || null,
    role: row.role || 'candidate',
    workIdentity: parseJson(row.work_identity_json, {}),
    signals: parseJson(row.signals_json, []),
    suppressions: parseJson(row.suppressions_json, []),
    labels: parseJson(row.labels_json, []),
    firstSeenAt: row.first_seen_at || null,
    lastSeenAt: row.last_seen_at || null,
    updatedAt: row.updated_at || null,
  };
}

function readFamily(db, familyId) {
  const family = db.prepare('SELECT * FROM duplicate_families WHERE family_id = ?').get(familyId) || null;
  if (!family) {
    throw new DuplicateFamilyPacketError(`duplicate family not found: ${familyId}`, {
      code: 'duplicate-family-not-found',
      details: { familyId },
    });
  }
  const candidates = duplicateFamilyCandidateRows(db, familyId).map(rowToCandidate);
  return {
    familyId: family.family_id,
    familyKey: family.family_key,
    targetRepo: family.target_repo,
    baseBranch: family.base_branch,
    normalizedWorkIdentity: family.normalized_work_identity,
    status: family.status,
    strongestSignal: family.strongest_signal || null,
    selectedSurvivorPrNumber: family.selected_survivor_pr_number || null,
    reportPath: family.report_path || null,
    operatorOverride: parseJson(family.operator_override_json, null),
    transitions: parseJson(family.transition_log_json, []),
    candidateCount: family.candidate_count,
    firstDetectedAt: family.first_detected_at,
    lastSeenAt: family.last_seen_at,
    updatedAt: family.updated_at,
    candidates,
  };
}

function readReviewStateEvidence(db, candidate) {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
  const reviewRow = tables.has('reviewed_prs') ? db.prepare(
    `SELECT *
       FROM reviewed_prs
      WHERE repo = ?
        AND pr_number = ?`
  ).get(candidate.repo, candidate.prNumber) || null : null;
  const passes = tables.has('reviewer_passes') ? db.prepare(
    `SELECT *
       FROM reviewer_passes
      WHERE repo = ?
        AND pr_number = ?
      ORDER BY COALESCE(ended_at, started_at) DESC, pass_id DESC
      LIMIT 10`
  ).all(candidate.repo, candidate.prNumber) : [];
  const verdicts = tables.has('review_cycle_verdicts') ? db.prepare(
    `SELECT head_sha, verdict_count, verdict_at, verdict_summary
       FROM review_cycle_verdicts
      WHERE pr_url = ?
      ORDER BY verdict_at DESC, id DESC
      LIMIT 10`
  ).all(prUrl(candidate.repo, candidate.prNumber)) : [];
  return { reviewRow, passes, verdicts };
}

async function collectGitEvidence(repoDir, family, deps) {
  const candidates = [];
  for (const candidate of family.candidates) {
    if (!(await ensureCandidateObject(repoDir, candidate, deps))) {
      throw new DuplicateFamilyPacketError(
        `missing persisted head object for ${candidate.repo}#${candidate.prNumber}: ${candidate.headSha || '<none>'}`,
        {
          code: 'missing-object',
          details: {
            reason: 'missing-persisted-head-object',
            repo: candidate.repo,
            prNumber: candidate.prNumber,
            headSha: candidate.headSha || null,
          },
        }
      );
    }
    const currentBase = await resolveBaseRef(repoDir, candidate, deps);
    const persistedBaseExists = candidate.baseSha
      ? await objectExists(repoDir, candidate.baseSha, deps)
      : false;
    const comparisonBase = persistedBaseExists ? candidate.baseSha : currentBase.sha;
    if (!comparisonBase) {
      throw new DuplicateFamilyPacketError(
        `missing base object for ${candidate.repo}#${candidate.prNumber}`,
        {
          code: 'missing-object',
          details: {
            reason: 'missing-base-object',
            repo: candidate.repo,
            prNumber: candidate.prNumber,
            baseSha: candidate.baseSha || null,
            baseBranch: candidate.baseBranch || null,
          },
        }
      );
    }
    const mergeBase = currentBase.sha
      ? await git(repoDir, ['merge-base', currentBase.sha, candidate.headSha], { ...deps, allowFailure: true })
      : null;
    const diffstat = await git(repoDir, ['diff', '--stat', comparisonBase, candidate.headSha], deps);
    const currentTreeDiffstat = currentBase.sha
      ? await git(repoDir, ['diff', '--stat', currentBase.sha, candidate.headSha], deps)
      : '';
    const staleBase = Boolean(
      currentBase.sha
      && candidate.baseSha
      && currentBase.sha !== candidate.baseSha
    );
    candidates.push({
      ...candidate,
      prUrl: prUrl(candidate.repo, candidate.prNumber),
      git: {
        persistedBaseObjectAvailable: persistedBaseExists,
        comparisonBase,
        currentBaseRef: currentBase.ref,
        currentBaseSha: currentBase.sha,
        mergeBaseWithCurrentBase: mergeBase,
        staleBaseDiagnostic: {
          staleBase,
          label: staleBase
            ? 'STALE-BASE DIAGNOSTIC: persisted candidate base differs from current base branch'
            : 'current-tree diagnostic: persisted candidate base matches current base branch',
          persistedBaseSha: candidate.baseSha || null,
          currentBaseSha: currentBase.sha || null,
        },
      },
      diffstat,
      currentTreeDiffstat,
    });
  }
  return candidates;
}

async function collectRangeDiff(repoDir, candidates, deps) {
  const lines = [];
  const ordered = [...candidates].sort((left, right) => left.prNumber - right.prNumber);
  for (let i = 0; i < ordered.length; i += 1) {
    for (let j = i + 1; j < ordered.length; j += 1) {
      const left = ordered[i];
      const right = ordered[j];
      lines.push(`# PR #${left.prNumber} (${shortSha(left.git.comparisonBase)}..${shortSha(left.headSha)}) vs PR #${right.prNumber} (${shortSha(right.git.comparisonBase)}..${shortSha(right.headSha)})`);
      const out = await git(repoDir, [
        'range-diff',
        `${left.git.comparisonBase}..${left.headSha}`,
        `${right.git.comparisonBase}..${right.headSha}`,
      ], { ...deps, allowFailure: true });
      lines.push(out || 'range-diff unavailable for this pair');
      lines.push('');
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

async function collectGithubEvidence(family, { fetchRollupImpl = fetchPullRequestRollup, skipGithub = false } = {}) {
  const evidence = {};
  for (const candidate of family.candidates) {
    if (skipGithub) {
      evidence[candidate.prNumber] = null;
      continue;
    }
    try {
      evidence[candidate.prNumber] = await fetchRollupImpl(candidate.repo, candidate.prNumber);
    } catch (err) {
      evidence[candidate.prNumber] = {
        unavailable: true,
        reason: err?.message || String(err),
      };
    }
  }
  return evidence;
}

function renderCandidateDiffstat(candidate) {
  return [
    `# PR #${candidate.prNumber} Diffstat`,
    '',
    `Repository: ${candidate.repo}`,
    `PR: ${candidate.prUrl}`,
    `Title: ${candidate.title || '(unknown)'}`,
    `Head: ${candidate.headSha}`,
    `Persisted base: ${candidate.baseSha || '(none)'}`,
    `Comparison base: ${candidate.git.comparisonBase}`,
    `Merge base with current ${candidate.baseBranch}: ${candidate.git.mergeBaseWithCurrentBase || '(unavailable)'}`,
    '',
    candidate.diffstat || '(empty diff)',
    '',
  ].join('\n');
}

function renderStaleDiagnostic(candidate) {
  return [
    `# PR #${candidate.prNumber} Current-Tree Stale-Base Diagnostic`,
    '',
    candidate.git.staleBaseDiagnostic.label,
    '',
    `Persisted base: ${candidate.git.staleBaseDiagnostic.persistedBaseSha || '(none)'}`,
    `Current ${candidate.baseBranch}: ${candidate.git.staleBaseDiagnostic.currentBaseSha || '(unavailable)'}`,
    `Head: ${candidate.headSha}`,
    '',
    'This file is diagnostic only. It compares the current base branch tree to the persisted candidate head.',
    '',
    candidate.currentTreeDiffstat || '(empty diff)',
    '',
  ].join('\n');
}

function renderReviewsMarkdown(packet) {
  const lines = ['# Review Evidence', ''];
  for (const candidate of packet.candidates) {
    const gh = packet.githubEvidence[String(candidate.prNumber)] || null;
    const db = packet.reviewStateEvidence[String(candidate.prNumber)] || {};
    const reviews = latestItems(gh?.reviews || [], 'submittedAt', 6);
    const unresolved = reviews.filter(reviewHasUnresolvedFinding);
    const checks = (Array.isArray(gh?.checks) ? gh.checks : []).map(normalizeCheck)
      .sort((left, right) => String(left.name).localeCompare(String(right.name)));
    lines.push(`## PR #${candidate.prNumber}`);
    lines.push('');
    lines.push(`- URL: ${candidate.prUrl}`);
    lines.push(`- State: ${gh?.state || candidate.prState || '(unknown)'}`);
    lines.push(`- Merge: mergeable=${gh?.mergeable || '(unknown)'}, mergeStateStatus=${gh?.mergeStateStatus || '(unknown)'}`);
    lines.push(`- Review row: ${db.reviewRow ? `${db.reviewRow.review_status} by ${db.reviewRow.reviewer || '(unknown)'} at ${db.reviewRow.reviewed_at || '(unknown)'}` : '(none)'}`);
    lines.push('');
    lines.push('### Check Rollup');
    lines.push('');
    if (checks.length === 0) {
      lines.push('- (no checks captured)');
    } else {
      for (const check of checks) {
        lines.push(`- ${check.name}: ${check.conclusion || '(unknown)'}${check.completedAt ? ` at ${check.completedAt}` : ''}`);
      }
    }
    lines.push('');
    lines.push('### Latest Reviews');
    lines.push('');
    if (reviews.length === 0) {
      lines.push('- (no GitHub reviews captured)');
    } else {
      for (const review of reviews) {
        const author = review?.author?.login || '(unknown)';
        const summary = String(review?.body || '').replace(/\s+/g, ' ').slice(0, 220);
        lines.push(`- ${review.state || '(unknown)'} by ${author} at ${review.submittedAt || '(unknown)'}${summary ? `: ${summary}` : ''}`);
      }
    }
    lines.push('');
    lines.push('### Unresolved Findings');
    lines.push('');
    if (unresolved.length === 0) {
      lines.push('- (none detected from latest review bodies)');
    } else {
      for (const review of unresolved) {
        lines.push(`- ${review.state || '(unknown)'} by ${review?.author?.login || '(unknown)'} at ${review.submittedAt || '(unknown)'}`);
      }
    }
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function renderCommentsMarkdown(packet) {
  const lines = ['# Relevant Comments', ''];
  for (const candidate of packet.candidates) {
    const gh = packet.githubEvidence[String(candidate.prNumber)] || null;
    const comments = latestItems(relevantComments(gh?.comments || []), 'createdAt', 10);
    lines.push(`## PR #${candidate.prNumber}`);
    lines.push('');
    if (comments.length === 0) {
      lines.push('- (no relevant comments captured)');
    } else {
      for (const comment of comments) {
        const author = comment?.author?.login || '(unknown)';
        const body = String(comment?.body || '').replace(/\s+/g, ' ').slice(0, 240);
        lines.push(`- ${comment.createdAt || '(unknown)'} ${author}: ${body}`);
      }
    }
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function renderReportSkeleton(packet) {
  const date = String(packet.family.firstDetectedAt || '').slice(0, 10) || 'YYYY-MM-DD';
  const prs = packet.candidates.map((candidate) => `#${candidate.prNumber}`).join(' vs ');
  const ticket = packet.family.normalizedWorkIdentity.toUpperCase();
  const comparisonRows = packet.candidates.map((candidate) => (
    `| #${candidate.prNumber} | \`${candidate.headBranch || '(unknown)'}\` | \`${shortSha(candidate.git.comparisonBase)}\` | \`${shortSha(candidate.headSha)}\` | TODO |`
  ));
  return [
    `# ${date} ${ticket} Duplicate PR Divergence: ${prs}`,
    '',
    '## Pair',
    '',
    `- Repository: \`${packet.family.targetRepo}\``,
    `- Ticket/theme: ${packet.family.normalizedWorkIdentity}`,
    `- Candidates: ${packet.candidates.map((candidate) => `[#${candidate.prNumber}](${candidate.prUrl})`).join(', ')}`,
    '- Survivor: TODO',
    '- Loser(s): TODO',
    '- Harness/model split: TODO',
    '- Final loser disposition: TODO',
    '',
    '## Decision',
    '',
    'TODO: Select exactly one survivor and explain why. Do not merge multiple family members.',
    '',
    '## Comparison',
    '',
    '| PR | Branch | Base | Head | Adjudicator read |',
    '| --- | --- | --- | --- | --- |',
    ...comparisonRows,
    '',
    'Evidence packet links:',
    '',
    '- [Family JSON](family.json)',
    '- [Range diff](range-diff.txt)',
    '- [Review evidence](reviews.md)',
    '- [Relevant comments](comments.md)',
    ...packet.candidates.flatMap((candidate) => [
      `- [PR #${candidate.prNumber} diffstat](candidate-${candidate.prNumber}.diffstat.txt)`,
      `- [PR #${candidate.prNumber} stale-base diagnostic](candidate-${candidate.prNumber}.stale-base-diagnostic.txt)`,
    ]),
    '',
    '## Salvage Folded Into Survivor',
    '',
    '- TODO',
    '',
    '## Divergence Notes',
    '',
    'TODO',
    '',
    '## Validation',
    '',
    '- TODO',
    '',
  ].join('\n');
}

function packetFamilyJson(packet) {
  return {
    family: packet.family,
    candidates: packet.candidates.map((candidate) => ({
      baseBranch: candidate.baseBranch,
      baseSha: candidate.baseSha,
      currentBaseSha: candidate.git.currentBaseSha,
      diffstatFile: `candidate-${candidate.prNumber}.diffstat.txt`,
      headBranch: candidate.headBranch,
      headSha: candidate.headSha,
      labels: candidate.labels,
      mergeBaseWithCurrentBase: candidate.git.mergeBaseWithCurrentBase,
      prNumber: candidate.prNumber,
      prState: candidate.prState,
      prUrl: candidate.prUrl,
      repo: candidate.repo,
      role: candidate.role,
      signals: candidate.signals,
      staleBaseDiagnostic: candidate.git.staleBaseDiagnostic,
      staleBaseDiagnosticFile: `candidate-${candidate.prNumber}.stale-base-diagnostic.txt`,
      suppressions: candidate.suppressions,
      title: candidate.title,
    })),
    githubEvidence: Object.fromEntries(Object.entries(packet.githubEvidence).map(([prNumber, evidence]) => [
      prNumber,
      evidence ? {
        unavailable: evidence.unavailable || false,
        reason: evidence.reason || null,
        author: evidence.author || null,
        checks: Array.isArray(evidence.checks) ? evidence.checks.map(normalizeCheck) : [],
        closedAt: evidence.closedAt || null,
        commentsCaptured: Array.isArray(evidence.comments) ? evidence.comments.length : 0,
        headRefName: evidence.headRefName || null,
        headRefOid: evidence.headRefOid || null,
        labels: evidence.labels || [],
        mergeStateStatus: evidence.mergeStateStatus || null,
        mergeable: evidence.mergeable || null,
        mergedAt: evidence.mergedAt || null,
        reviewsCaptured: Array.isArray(evidence.reviews) ? evidence.reviews.length : 0,
        state: evidence.state || null,
        title: evidence.title || null,
      } : null,
    ])),
    reviewStateEvidence: packet.reviewStateEvidence,
  };
}

async function buildDuplicateFamilyPacket({
  rootDir = process.cwd(),
  familyId,
  repoDir = process.cwd(),
  db = null,
  execFileImpl = execFileDefault,
  fetchRollupImpl = fetchPullRequestRollup,
  skipGithub = false,
} = {}) {
  if (!familyId) {
    throw new DuplicateFamilyPacketError('family id is required', { code: 'missing-family-id' });
  }
  const ownDb = db || openReviewStateDb(rootDir);
  try {
    const family = readFamily(ownDb, familyId);
    const gitCandidates = await collectGitEvidence(resolve(repoDir), family, { execFileImpl });
    const githubEvidence = await collectGithubEvidence({ ...family, candidates: gitCandidates }, {
      fetchRollupImpl,
      skipGithub,
    });
    const reviewStateEvidence = Object.fromEntries(gitCandidates.map((candidate) => [
      String(candidate.prNumber),
      readReviewStateEvidence(ownDb, candidate),
    ]));
    const packet = {
      family: { ...family, candidates: undefined },
      candidates: gitCandidates,
      githubEvidence,
      reviewStateEvidence,
      rangeDiff: await collectRangeDiff(resolve(repoDir), gitCandidates, { execFileImpl }),
    };
    return {
      packet,
      files: {
        'family.json': stableJson(packetFamilyJson(packet)),
        'range-diff.txt': packet.rangeDiff,
        'reviews.md': renderReviewsMarkdown(packet),
        'comments.md': renderCommentsMarkdown(packet),
        'report-skeleton.md': renderReportSkeleton(packet),
        ...Object.fromEntries(packet.candidates.flatMap((candidate) => [
          [`candidate-${candidate.prNumber}.diffstat.txt`, renderCandidateDiffstat(candidate)],
          [`candidate-${candidate.prNumber}.stale-base-diagnostic.txt`, renderStaleDiagnostic(candidate)],
        ])),
      },
    };
  } finally {
    if (!db) ownDb.close();
  }
}

function writeDuplicateFamilyPacket(packetResult, outDir) {
  const targetDir = resolve(outDir);
  mkdirSync(targetDir, { recursive: true });
  const names = Object.keys(packetResult.files).sort();
  for (const name of names) {
    writeFileSync(join(targetDir, name), packetResult.files[name], 'utf8');
  }
  return names.map((name) => join(targetDir, name));
}

function parsePacketArgs(argv) {
  const options = {
    familyId: null,
    rootDir: process.cwd(),
    repoDir: process.cwd(),
    outDir: null,
    skipGithub: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') {
      if (!argv[i + 1]) throw new Error('--root requires a directory');
      options.rootDir = argv[++i];
    } else if (arg === '--repo-dir') {
      if (!argv[i + 1]) throw new Error('--repo-dir requires a directory');
      options.repoDir = argv[++i];
    } else if (arg === '--out') {
      if (!argv[i + 1]) throw new Error('--out requires a directory');
      options.outDir = argv[++i];
    } else if (arg === '--no-github') {
      options.skipGithub = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (!options.familyId) {
      options.familyId = arg;
    } else {
      throw new Error(`Unknown packet argument: ${arg}`);
    }
  }
  if (!options.help && !options.familyId) {
    throw new Error('duplicate-family packet requires <family-id>');
  }
  if (!options.outDir && options.familyId) {
    options.outDir = join(options.rootDir, 'data', 'duplicate-family-packets', options.familyId);
  }
  return options;
}

const PACKET_USAGE = `\
Usage:
  adversarial-review duplicate-family packet <family-id> [--root <dir>] [--repo-dir <dir>] [--out <dir>] [--no-github]
`;

async function duplicateFamilyMain(argv, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const [subcommand, ...rest] = argv;
  if (subcommand !== 'packet') {
    stderr.write(`error: unknown duplicate-family command ${subcommand || '<none>'}\n\n${PACKET_USAGE}`);
    return 2;
  }
  let options;
  try {
    options = parsePacketArgs(rest);
  } catch (err) {
    stderr.write(`error: ${err.message}\n\n${PACKET_USAGE}`);
    return 2;
  }
  if (options.help) {
    stdout.write(PACKET_USAGE);
    return 0;
  }
  try {
    const packetResult = await buildDuplicateFamilyPacket(options);
    const written = writeDuplicateFamilyPacket(packetResult, options.outDir);
    stdout.write(`wrote duplicate-family packet for ${options.familyId}:\n`);
    for (const filePath of written) {
      stdout.write(`${filePath}\n`);
    }
    return 0;
  } catch (err) {
    if (err instanceof DuplicateFamilyPacketError) {
      stderr.write(`error: ${err.code}: ${err.message}\n`);
      if (err.details && Object.keys(err.details).length > 0) {
        stderr.write(`${stableJson({ details: err.details })}`);
      }
      return err.code === 'missing-object' ? 3 : 2;
    }
    stderr.write(`error: ${err?.message || err}\n`);
    return 1;
  }
}

export {
  DuplicateFamilyPacketError,
  buildDuplicateFamilyPacket,
  duplicateFamilyMain,
  parsePacketArgs,
  writeDuplicateFamilyPacket,
};
