/**
 * LAC-12 + LAC-13: Reviewer Agent + Linear Integration
 *
 * One-shot: fetch PR diff → adversarial review → post GitHub comment → update Linear.
 *
 * Called by watcher.mjs as a child process:
 *   node src/reviewer.mjs '<JSON args>'
 *
 * Args JSON shape:
 *   { repo, prNumber, reviewerModel, botTokenEnv, linearTicketId }
 *
 * ── Auth Policy (NON-NEGOTIABLE) ────────────────────────────────────────────
 * Claude reviews MUST use OAuth (claude CLI), never ANTHROPIC_API_KEY.
 * Codex reviews MUST use OAuth (codex CLI), never OPENAI_API_KEY.
 * If OAuth credentials are missing or expired → STOP and alert Paul via Clio.
 * API key fallback is intentionally NOT implemented here.
 * ────────────────────────────────────────────────────────────────────────────
 */

import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createFollowUpJob } from './follow-up-jobs.mjs';

const execFileAsync = promisify(execFile);

function spawnWithInput(command, args, { env, cwd, input = '', timeout = 0, maxBuffer = 10 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const finishReject = (err) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      reject(err);
    };

    const killTimer = timeout > 0
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
        }, timeout)
      : null;

    const appendChecked = (target, chunk) => {
      const next = target + chunk;
      if (next.length > maxBuffer) {
        child.kill('SIGTERM');
        const err = new Error(`spawnWithInput maxBuffer exceeded (${maxBuffer} bytes)`);
        err.stdout = stdout;
        err.stderr = stderr;
        finishReject(err);
        return null;
      }
      return next;
    };

    child.stdout.on('data', (data) => {
      if (settled) return;
      const next = appendChecked(stdout, data.toString());
      if (next !== null) stdout = next;
    });

    child.stderr.on('data', (data) => {
      if (settled) return;
      const next = appendChecked(stderr, data.toString());
      if (next !== null) stderr = next;
    });

    child.on('error', (err) => {
      if (settled) return;
      err.stdout = stdout;
      err.stderr = stderr;
      finishReject(err);
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      if (code === 0) {
        resolve({ stdout, stderr, code, signal });
        return;
      }
      const err = new Error(
        timedOut
          ? `Command timed out after ${timeout}ms`
          : `Command failed with code ${code}${signal ? ` signal ${signal}` : ''}`
      );
      err.code = code;
      err.signal = signal;
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    });

    child.stdin.end(input);
  });
}

async function spawnCaptured(command, args, { env, cwd, timeout = 0, maxBuffer = 10 * 1024 * 1024 } = {}) {
  return spawnWithInput(command, args, { env, cwd, input: '', timeout, maxBuffer });
}

// ── CLI paths ────────────────────────────────────────────────────────────────

// Claude Code CLI — runs as the current user.
// Must NOT have ANTHROPIC_API_KEY in env when validating or invoking,
// otherwise the CLI may report API-key auth instead of its native login state.
const CLAUDE_CLI = '/opt/homebrew/bin/claude';

// ACPX-local Codex adapter path. The reviewer keeps wrapper-owned completion
// semantics: ACPX/Codex does the work, and the outer wrapper owns parsing /
// posting / downstream side effects. Today the handoff is ACPX stdout capture;
// explicit file-artifact handoff remains a valid future refinement.
const ACPX_CLI = '/Users/airlock/.openclaw/tools/acpx/node_modules/.bin/acpx';

// Raw Codex CLI is still used only for login-status probing.
const CODEX_CLI = '/Users/placey/.local/share/fnm/node-versions/v24.14.0/installation/bin/codex';

// OPENAI_API_KEY is stripped from env so Codex cannot fall back to API-key auth.

// ── OAuth credential checks ──────────────────────────────────────────────────

/**
 * Verify Claude auth is available through the CLI's native login state.
 *
 * IMPORTANT: strip ANTHROPIC_API_KEY from env before probing, otherwise
 * `claude auth status` may report API-key mode and mask the real login state.
 */
async function assertClaudeOAuth() {
  if (!existsSync(CLAUDE_CLI)) {
    throw new OAuthError('claude', `claude CLI not found at ${CLAUDE_CLI}`);
  }

  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;

  let stdout = '';
  let stderr = '';
  try {
    ({ stdout, stderr } = await execFileAsync(
      CLAUDE_CLI,
      ['auth', 'status'],
      { env, timeout: 10_000 }
    ));
  } catch (err) {
    stdout = err.stdout || '';
    stderr = err.stderr || '';
    const msg = `${err.message || ''}\n${stdout}\n${stderr}`.toLowerCase();
    if (msg.includes('not logged in') || msg.includes('login required') || msg.includes('unauthorized')) {
      throw new OAuthError('claude', `Claude CLI reports not logged in: ${(stdout || stderr || err.message).trim()}`);
    }
    throw new OAuthError('claude', `Claude auth probe failed: ${(stdout || stderr || err.message).trim()}`);
  }

  const text = `${stdout || ''}\n${stderr || ''}`.toLowerCase();
  if (text.includes('"loggedin": false') || text.includes('not logged in') || text.includes('login required')) {
    throw new OAuthError('claude', `Claude CLI reports not logged in: ${(stdout || stderr).trim()}`);
  }
}

function resolveCodexAuthPath() {
  // Codex OAuth credentials are stored under the placey user (who owns Codex),
  // not necessarily under the current process HOME. CODEX_AUTH_PATH env var
  // allows explicit override; otherwise default to placey's home.
  return process.env.CODEX_AUTH_PATH || '/Users/placey/.codex/auth.json';
}

/**
 * Verify the intended Codex auth.json exists, is readable, and is OAuth/chatgpt mode.
 * This reads the file directly rather than trusting CLI commands that may be unavailable.
 */
function assertCodexAuthReadable() {
  const authPath = resolveCodexAuthPath();
  if (!existsSync(authPath)) {
    throw new OAuthError('codex', `OAuth auth.json missing: ${authPath}`);
  }

  let raw;
  try {
    raw = readFileSync(authPath, 'utf8');
  } catch (err) {
    throw new OAuthError('codex', `cannot read ${authPath}: ${err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new OAuthError('codex', `invalid auth.json at ${authPath}: ${err.message}`);
  }

  if ((parsed?.auth_mode || '').toLowerCase() !== 'chatgpt') {
    throw new OAuthError('codex', `Codex auth file is not OAuth/chatgpt mode (found: ${parsed?.auth_mode}): ${authPath}`);
  }

  if (!parsed?.tokens?.access_token || !parsed?.tokens?.refresh_token) {
    throw new OAuthError('codex', `Codex auth.json missing required OAuth tokens: ${authPath}`);
  }

  if (!parsed?.tokens?.access_token || !parsed?.tokens?.refresh_token) {
    throw new OAuthError('codex', `Codex auth file missing OAuth tokens: ${authPath}`);
  }

  return authPath;
}

async function assertCodexOAuth() {
  if (!existsSync(CODEX_CLI)) {
    throw new OAuthError('codex', `codex CLI not found at ${CODEX_CLI}`);
  }

  // Verify auth.json is readable and contains valid OAuth tokens.
  // This is more reliable than CLI probes, which may not support `login status`.
  assertCodexAuthReadable();
}

/**
 * Custom error class for OAuth failures — triggers Clio alert in main().
 */
class OAuthError extends Error {
  constructor(model, reason) {
    super(`[OAuth] ${model} credentials unavailable: ${reason}`);
    this.model = model;
    this.isOAuthError = true;
  }
}

// ── Utility functions ────────────────────────────────────────────────────────

function looksLikeRuntimeJunk(text) {
  const normalized = String(text ?? '').toLowerCase();
  return /\[client\]|\[agent\]|running|initializ|session|reading additional input|reading prompt from stdin|could not update path|operation not permitted|error:|timed out/.test(normalized);
}

function stripCodexRuntimeNoise(text) {
  const lines = String(text ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n');

  const filtered = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    return !(
      /^warning:\s+proceeding, even though we could not update path:/i.test(trimmed) ||
      /^reading prompt from stdin/i.test(trimmed) ||
      /^reading additional input from stdin/i.test(trimmed) ||
      /^openai codex v/i.test(trimmed) ||
      /^model:/i.test(trimmed) ||
      /^cwd:/i.test(trimmed) ||
      /^approval:/i.test(trimmed) ||
      /^sandbox:/i.test(trimmed) ||
      /^reasoning:/i.test(trimmed)
    );
  });

  return filtered.join('\n').trim();
}

function previewText(text, limit = 200) {
  const normalized = String(text ?? '').replace(/\r\n/g, '\n').trim();
  if (!normalized) return '<empty>';
  return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized;
}

// ── Adversarial prompt (NON-NEGOTIABLE) ──────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');
const REVIEWER_PROMPT_PATH = join(__dirname, '..', 'prompts', 'reviewer-prompt.md');
const ADVERSARIAL_PROMPT = readFileSync(REVIEWER_PROMPT_PATH, 'utf8').trim();

// ── Critical-issue detection ─────────────────────────────────────────────────

const CRITICAL_WORDS = ['critical', 'vulnerability', 'security', 'injection'];

function isCritical(reviewText) {
  const lower = reviewText.toLowerCase();
  return CRITICAL_WORDS.some((w) => lower.includes(w));
}

function normalizeWhitespace(text) {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function titleCaseWords(value) {
  return String(value ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

function sanitizeCodexReviewPayload(reviewText) {
  let text = normalizeWhitespace(reviewText)
    .replace(/^#\s+/gm, '## ')
    .replace(/^###\s+/gm, '## ')
    .replace(/^####\s+/gm, '## ')
    .replace(/^##\s+(summary|blocking issues|non-blocking issues|suggested fixes|verdict)\s*:?$/gim, (_, heading) => `## ${titleCaseWords(heading)}`);

  const sectionRegex = /^##\s+(Summary|Blocking issues|Non-blocking issues|Suggested fixes|Verdict)\s*$/gim;
  const matches = [...text.matchAll(sectionRegex)];
  if (matches.length === 0) {
    if (looksLikeRuntimeJunk(text)) {
      throw new Error('Codex payload did not contain recognizable review sections and still looked like runtime junk');
    }
    throw new Error('Codex payload did not contain recognizable review sections');
  }

  const firstSeen = new Set();
  const kept = [];
  for (const match of matches) {
    const heading = titleCaseWords(match[1]);
    if (firstSeen.has(heading)) break;
    firstSeen.add(heading);
    kept.push({ heading, index: match.index, raw: match[0] });
    if (heading === 'Verdict') break;
  }

  if (!firstSeen.has('Summary') || !firstSeen.has('Verdict')) {
    throw new Error('Codex payload missing required Summary/Verdict sections');
  }

  const trimmedSections = [];
  for (let i = 0; i < kept.length; i += 1) {
    const start = kept[i].index;
    const end = i + 1 < kept.length ? kept[i + 1].index : text.length;
    trimmedSections.push(normalizeWhitespace(text.slice(start, end)));
    if (kept[i].heading === 'Verdict') break;
  }

  const sanitized = trimmedSections.join('\n\n').trim();
  if (!sanitized) {
    throw new Error('Codex payload was empty after sanitation');
  }

  return sanitized;
}

function parseGitHubBlobPath(candidateUrl, expectedRepo) {
  let parsed;
  try {
    parsed = new URL(candidateUrl);
  } catch {
    return null;
  }

  if (parsed.hostname !== 'github.com') {
    return null;
  }

  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length < 5 || parts[2] !== 'blob') {
    return null;
  }

  const repo = `${parts[0]}/${parts[1]}`;
  if (repo !== expectedRepo) {
    return null;
  }

  const pathParts = parts.slice(4);
  if (!pathParts.length) {
    return null;
  }

  const relPath = pathParts.join('/');
  return relPath.endsWith('.md') ? relPath : null;
}

// ── PR diff fetch ────────────────────────────────────────────────────────────

async function fetchPRDiff(repo, prNumber) {
  const { stdout } = await execFileAsync(
    'gh',
    ['pr', 'diff', String(prNumber), '--repo', repo],
    { maxBuffer: 10 * 1024 * 1024 }
  );
  return stdout;
}

async function fetchPRContext(repo, prNumber) {
  const { stdout } = await execFileAsync(
    'gh',
    ['pr', 'view', String(prNumber), '--repo', repo, '--json', 'body,comments,headRefOid'],
    { maxBuffer: 10 * 1024 * 1024 }
  );
  return JSON.parse(stdout);
}

function extractLinkedRepoDocs(text, repo) {
  const rels = new Set();
  const patterns = [
    /(?:^|\s)(projects\/[A-Za-z0-9._\/-]+\.md|docs\/[A-Za-z0-9._\/-]+\.md|agents\/[A-Za-z0-9._\/-]+\.md|knowledge\/[A-Za-z0-9._\/-]+\.md|modules\/[A-Za-z0-9._\/-]+\.md|tools\/[A-Za-z0-9._\/-]+\.md)/g,
    /\((\.?\/?(?:projects|docs|agents|knowledge|modules|tools)\/[A-Za-z0-9._\/-]+\.md)\)/g,
  ];

  for (const pattern of patterns) {
    let m;
    while ((m = pattern.exec(text)) !== null) {
      const rel = m[1];
      if (!rel) continue;
      const normalized = rel.replace(/^\.\//, '');
      if (normalized.endsWith('.md')) rels.add(normalized);
    }
  }

  const urlMatches = String(text ?? '').match(/https:\/\/github\.com\/[^\s)]+/g) || [];
  for (const rawUrl of urlMatches) {
    const relPath = parseGitHubBlobPath(rawUrl, repo);
    if (relPath) {
      rels.add(relPath);
    }
  }

  return [...rels].sort();
}

async function fetchLinkedSpecContents(repo, prNumber, { fetchPRContextImpl = fetchPRContext, execFileImpl = execFileAsync } = {}) {
  const pr = await fetchPRContextImpl(repo, prNumber);
  const combinedText = [pr.body || '', ...(pr.comments || []).map((c) => c.body || '')].join('\n\n');
  const linked = extractLinkedRepoDocs(combinedText, repo).slice(0, 12);
  if (!linked.length) return '';

  const sections = await Promise.all(linked.map(async (relPath) => {
    try {
      const { stdout } = await execFileImpl(
        'gh',
        ['api', `repos/${repo}/contents/${relPath}?ref=${pr.headRefOid}`, '--jq', '.content'],
        { maxBuffer: 10 * 1024 * 1024 }
      );
      const decoded = Buffer.from(stdout.replace(/\n/g, ''), 'base64').toString('utf8');
      const trimmed = decoded.length > 12000 ? `${decoded.slice(0, 12000)}\n\n[truncated]` : decoded;
      return `### ${relPath}\n\n\`\`\`md\n${trimmed}\n\`\`\``;
    } catch (err) {
      return `### ${relPath}\n\n[failed to fetch linked spec: ${err.message}]`;
    }
  }));

  return `\n\n---\n\nAdditional linked project context from the PR body/comments (fetch and use these as governing docs when relevant):\n\n${sections.join('\n\n')}`;
}

// ── AI review via CLI (OAuth only) ──────────────────────────────────────────

/**
 * Run adversarial review using Claude Code CLI (OAuth).
 * ANTHROPIC_API_KEY is explicitly removed from the env so the CLI
 * uses its native OAuth path only. Preflight auth validation is aligned with
 * the broker/Keychain path used by the live stack.
 */
async function reviewWithClaude(diff, extraContext = '') {
  await assertClaudeOAuth();

  const prompt = `${ADVERSARIAL_PROMPT}${extraContext}\n\n---\n\nHere is the PR diff to review:\n\n\`\`\`diff\n${diff}\`\`\``;

  // Strip API key from env — Claude CLI falls back to OAuth when it's absent
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;

  let stdout, stderr;
  try {
    ({ stdout, stderr } = await execFileAsync(
      CLAUDE_CLI,
      ['--print', '--permission-mode', 'bypassPermissions', prompt],
      {
        env,
        timeout: 5 * 60 * 1000,
        maxBuffer: 10 * 1024 * 1024,
      }
    ));
  } catch (err) {
    // Detect OAuth expiry in error output
    const msg = (err.message || '') + (err.stderr || '');
    if (msg.includes('401') || msg.includes('Unauthorized') || msg.includes('oauth') || msg.includes('login')) {
      throw new OAuthError('claude', `CLI returned auth error: ${msg.substring(0, 200)}`);
    }
    throw err;
  }

  if (!stdout?.trim()) {
    const hint = stderr?.trim() ? ` stderr: ${stderr.substring(0, 200)}` : '';
    throw new Error(`Claude CLI returned empty output.${hint}`);
  }

  return stdout.trim();
}

/**
 * Run adversarial review using Codex CLI (OAuth).
 * OPENAI_API_KEY is explicitly removed from the env so Codex
 * uses its stored OAuth credentials only.
 *
 * Note: ACPX session bootstrap is currently broken in this environment
 * (see runbooks/INCIDENT-2026-04-21-ACPX-codex-exec-regression.md).
 * Using native Codex CLI instead, which is stable and produces quality reviews.
 */
async function reviewWithCodex(diff, extraContext = '') {
  console.error('[reviewWithCodex] asserting OAuth...');
  await assertCodexOAuth();
  console.error('[reviewWithCodex] OAuth OK');

  if (!existsSync(CODEX_CLI)) {
    throw new Error(`Codex CLI not found at ${CODEX_CLI}`);
  }

  const prompt = `${ADVERSARIAL_PROMPT}${extraContext}\n\n---\n\nHere is the PR diff to review:\n\n\`\`\`diff\n${diff}\`\`\``;
  const authPath = resolveCodexAuthPath();
  const outputPath = join(tmpdir(), `codex-review-${process.pid}-${Date.now()}.md`);

  const env = {
    ...process.env,
    PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    CODEX_AUTH_PATH: authPath,
    HOME: process.env.HOME || '/Users/placey',
  };
  delete env.OPENAI_API_KEY;

  let stdout = '';
  let stderr = '';
  try {
    console.error('[reviewWithCodex] invoking native Codex CLI');
    const result = await spawnCaptured(
      CODEX_CLI,
      [
        'exec',
        '--dangerously-bypass-approvals-and-sandbox',
        '--ephemeral',
        '--output-last-message',
        outputPath,
        '--',
        prompt,
      ],
      {
        env,
        cwd: process.cwd(),
        timeout: 5 * 60 * 1000,
        maxBuffer: 10 * 1024 * 1024,
      }
    );
    stdout = result.stdout || '';
    stderr = result.stderr || '';
  } catch (err) {
    stdout = err.stdout || '';
    stderr = err.stderr || '';
    const msg = `${err.message || ''}\n${stdout}\n${stderr}`;
    if (/401|unauthorized|oauth|login required|not logged in/i.test(msg)) {
      throw new OAuthError('codex', `CLI returned auth error: ${msg.substring(0, 200)}`);
    }
    throw new Error(`Native Codex exec failed: ${msg.substring(0, 800)}`);
  }

  let fileOutput = '';
  const outputFileExists = existsSync(outputPath);
  try {
    if (outputFileExists) {
      fileOutput = readFileSync(outputPath, 'utf8');
    }
  } finally {
    try { unlinkSync(outputPath); } catch {}
  }

  console.error(`[reviewWithCodex] native Codex returned stdout length=${stdout.length}; stderr length=${stderr.length}; file exists=${outputFileExists}; file length=${fileOutput.length}`);
  console.error(`[reviewWithCodex] stdout preview: ${previewText(stdout)}`);
  console.error(`[reviewWithCodex] stderr preview: ${previewText(stderr)}`);
  console.error(`[reviewWithCodex] file preview: ${previewText(fileOutput)}`);

  const cleanedStdout = stripCodexRuntimeNoise(stdout);
  const cleanedStderr = stripCodexRuntimeNoise(stderr);
  const cleanedFile = stripCodexRuntimeNoise(fileOutput);
  const combined = normalizeWhitespace(cleanedFile || cleanedStdout || cleanedStderr || '');

  if (looksLikeRuntimeJunk(stdout) && !combined) {
    throw new Error(`Native Codex returned runtime/status junk instead of a review: ${stdout.substring(0, 400)}`);
  }

  if (!combined) {
    const hint = stderr?.trim() ? ` stderr: ${stderr.substring(0, 200)}` : '';
    throw new Error(`Native Codex returned empty output.${hint}`);
  }

  return combined;
}

// ── GitHub review posting ────────────────────────────────────────────────────

async function postGitHubReview(repo, prNumber, reviewBody, botTokenEnv) {
  const token = process.env[botTokenEnv];
  if (!token) {
    throw new Error(`Missing env var: ${botTokenEnv}`);
  }

  await execFileAsync(
    'gh',
    ['pr', 'review', String(prNumber), '--repo', repo, '--comment', '--body', reviewBody],
    {
      env: { ...process.env, GH_TOKEN: token },
      maxBuffer: 5 * 1024 * 1024,
    }
  );
}

// ── Clio alert (OAuth failure) ───────────────────────────────────────────────

/**
 * Alert Paul via Clio when OAuth credentials are unavailable.
 * Uses the OpenClaw wake hook to deliver a Telegram message.
 */
async function alertClioOAuthFailure(model, repo, prNumber, reason) {
  const msg = `🔐 Adversarial reviewer STOPPED — ${model} OAuth credentials unavailable.\n\nRepo: ${repo} PR #${prNumber}\nReason: ${reason}\n\nAction needed: re-authenticate ${model} (run the CLI and log in). PR review is paused until credentials are restored.`;

  console.error(`[reviewer] ALERT: ${msg}`);

  // Try to wake Clio via the OpenClaw hook
  try {
    await execFileAsync(
      'curl',
      [
        '-s', '-X', 'POST',
        'http://127.0.0.1:8787/hooks/wake',
        '-H', 'Content-Type: application/json',
        '-d', JSON.stringify({ message: msg }),
      ],
      { timeout: 10_000 }
    );
    console.log('[reviewer] Clio alert sent via wake hook');
  } catch (err) {
    console.error('[reviewer] Failed to send Clio alert:', err.message);
    // Alert is best-effort — the error is already in watcher logs
  }
}

// ── Linear integration (LAC-13) ──────────────────────────────────────────────

async function updateLinearTicket(ticketId, { reviewComplete, critical, reviewSummary }) {
  if (!ticketId || !process.env.LINEAR_API_KEY) return;

  const { LinearClient } = await import('@linear/sdk');
  const linear = new LinearClient({ apiKey: process.env.LINEAR_API_KEY });

  let issue;
  try {
    issue = await linear.issue(ticketId);
  } catch (err) {
    console.error(`[reviewer] Linear: could not find issue ${ticketId}:`, err.message);
    return;
  }

  if (reviewComplete) {
    const team = await issue.team;
    const states = await team.states();
    const doneState = states.nodes.find((s) => {
      const name = s.name.toLowerCase();
      return name === 'review complete' || name === 'done';
    });
    if (doneState) {
      await linear.updateIssue(issue.id, { stateId: doneState.id });
      console.log(`[reviewer] Linear ${ticketId} → ${doneState.name}`);
    }
  }

  if (critical) {
    const flagComment =
      `⚠️ **Adversarial review flagged critical issues** — Paul, please review.\n\n` +
      `Issues detected: ${CRITICAL_WORDS.filter((w) => reviewSummary.toLowerCase().includes(w)).join(', ')}\n\n` +
      `Full review posted as a GitHub PR comment.`;

    await linear.createComment({ issueId: issue.id, body: flagComment });
    console.log(`[reviewer] Linear ${ticketId} — critical flag comment added`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const rawArgs = process.argv[2];
  if (!rawArgs) {
    console.error('[reviewer] Usage: node src/reviewer.mjs \'<JSON args>\'');
    process.exit(1);
  }

  let args;
  try {
    args = JSON.parse(rawArgs);
  } catch {
    console.error('[reviewer] Invalid JSON args:', rawArgs);
    process.exit(1);
  }

  const { repo, prNumber, reviewerModel, botTokenEnv, linearTicketId } = args;

  if (!repo || !prNumber || !reviewerModel || !botTokenEnv) {
    console.error('[reviewer] Missing required fields in args:', args);
    process.exit(1);
  }

  console.log(`[reviewer] Starting review: ${repo}#${prNumber} model=${reviewerModel} (OAuth-only mode)`);
  console.error(`[reviewer] DEBUG: args=${JSON.stringify(args)}`);

  // 1. Fetch diff
  let diff;
  try {
    console.error(`[reviewer] DEBUG: fetching diff for ${repo}#${prNumber}...`);
    diff = await fetchPRDiff(repo, prNumber);
    console.error(`[reviewer] DEBUG: fetched diff (${diff.length} bytes)`);
  } catch (err) {
    console.error(`[reviewer] Failed to fetch diff for ${repo}#${prNumber}:`, err.message);
    process.exit(1);
  }

  if (!diff.trim()) {
    console.log(`[reviewer] Empty diff for ${repo}#${prNumber} — nothing to review`);
    process.exit(0);
  }

  let extraContext = '';
  try {
    extraContext = await fetchLinkedSpecContents(repo, prNumber);
    if (extraContext) {
      console.error(`[reviewer] DEBUG: fetched linked PR context (${extraContext.length} bytes)`);
    } else {
      console.error('[reviewer] DEBUG: no linked PR context found');
    }
  } catch (err) {
    console.error(`[reviewer] WARN: failed to fetch linked PR context: ${err.message}`);
  }

  // 2. Run adversarial review (OAuth only — no API key fallback)
  const effectiveModel = reviewerModel;

  let reviewText;
  let rawReviewText;
  try {
    console.error(`[reviewer] DEBUG: starting ${effectiveModel} review...`);
    if (effectiveModel === 'claude') {
      rawReviewText = await reviewWithClaude(diff, extraContext);
      reviewText = rawReviewText;
    } else {
      rawReviewText = await reviewWithCodex(diff, extraContext);
      console.error(`[reviewer] DEBUG: raw Codex review length=${rawReviewText.length}; preview=${previewText(rawReviewText)}`);
      try {
        reviewText = sanitizeCodexReviewPayload(rawReviewText);
      } catch (sanitizeErr) {
        console.error(`[reviewer] SANITIZE FAILED: ${sanitizeErr.message}`);
        console.error(`[reviewer] SANITIZE INPUT PREVIEW: ${previewText(rawReviewText, 400)}`);
        throw sanitizeErr;
      }
    }
    console.error(`[reviewer] DEBUG: review completed (${reviewText.length} bytes)`);
  } catch (err) {
    if (err.isOAuthError) {
      // OAuth failure — stop work and alert Paul
      await alertClioOAuthFailure(reviewerModel, repo, prNumber, err.message);
      console.error(`[reviewer] Stopped: OAuth credentials unavailable for ${reviewerModel}`);
      process.exit(2); // exit code 2 = auth failure (distinct from other errors)
    }
    console.error(`[reviewer] AI review failed for ${repo}#${prNumber}:`, err.message);
    console.error(`[reviewer] ERROR STACK: ${err.stack}`);
    process.exit(1);
  }

  console.log(`[reviewer] Review generated (${reviewText.length} chars)`);

  // 3. Post to GitHub
  const header =
    effectiveModel === 'claude'
      ? '## Adversarial Review — Claude (claude-reviewer-lacey)\n\n'
      : '## Adversarial Review — Codex (codex-reviewer-lacey)\n\n';
  const fullComment = header + reviewText;

  try {
    console.error(`[reviewer] DEBUG: posting GitHub review body length=${fullComment.length}; preview=${previewText(fullComment, 300)}`);
    await postGitHubReview(repo, prNumber, fullComment, botTokenEnv);
    console.log(`[reviewer] Review posted to ${repo}#${prNumber}`);
  } catch (err) {
    console.error(`[reviewer] GITHUB POST FAILED for ${repo}#${prNumber}:`, err.message);
    process.exit(1);
  }

  const critical = isCritical(reviewText);
  const reviewPostedAt = new Date().toISOString();
  try {
    const { jobPath } = createFollowUpJob({
      rootDir: ROOT,
      repo,
      prNumber,
      reviewerModel: effectiveModel,
      linearTicketId,
      reviewBody: reviewText,
      reviewPostedAt,
      critical,
    });
    console.log(`[reviewer] Follow-up handoff queued at ${jobPath}`);
  } catch (err) {
    console.error(`[reviewer] Failed to queue follow-up handoff for ${repo}#${prNumber}:`, err.message);
  }

  // 4. Update Linear (LAC-13)
  try {
    console.error(`[reviewer] DEBUG: updating Linear ticket ${linearTicketId || '<none>'}; critical=${critical}`);
    await updateLinearTicket(linearTicketId, {
      reviewComplete: true,
      critical,
      reviewSummary: reviewText,
    });
  } catch (err) {
    console.error(`[reviewer] LINEAR UPDATE FAILED for ${linearTicketId}:`, err.message);
    // Non-fatal — review was posted, just log and continue
  }

  if (critical) {
    console.log(`[reviewer] CRITICAL issues detected in ${repo}#${prNumber} — Paul flagged in Linear`);
  }

  console.log(`[reviewer] Done: ${repo}#${prNumber}`);
}

export {
  extractLinkedRepoDocs,
  fetchLinkedSpecContents,
  parseGitHubBlobPath,
  sanitizeCodexReviewPayload,
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('[reviewer] Unhandled error:', err);
    process.exit(1);
  });
}
