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

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ── CLI paths ────────────────────────────────────────────────────────────────

// Claude Code CLI — runs as the current user.
// Must NOT have ANTHROPIC_API_KEY in env when validating or invoking,
// otherwise the CLI may report API-key auth instead of its native login state.
const CLAUDE_CLI = '/opt/homebrew/bin/claude';

// ACPX-local Codex adapter path. The reviewer uses ACPX instead of invoking raw
// codex directly so Codex execution follows the same harness contract as the
// rest of the ACPX/OpenClaw stack.
const ACPX_CLI = '/Users/airlock/.openclaw/tools/acpx/node_modules/.bin/acpx';

// Raw Codex CLI is still used only for login-status probing.
const CODEX_CLI = '/Users/placey/.local/share/fnm/node-versions/v24.14.0/installation/bin/codex';

// Codex OAuth tokens copied from placey to airlock's ~/.codex/auth.json.
// The reviewer runs as airlock and uses airlock's HOME directly.
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
  return process.env.CODEX_AUTH_PATH || join(process.env.HOME || '/Users/airlock', '.codex', 'auth.json');
}

/**
 * Verify the intended Codex auth.json exists, is readable, and is OAuth/chatgpt mode.
 * This avoids trusting whatever default per-user state `codex login status` may inspect.
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
    throw new OAuthError('codex', `Codex auth file is not OAuth/chatgpt mode: ${authPath}`);
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

  const authPath = assertCodexAuthReadable();

  // Run login status with OPENAI_API_KEY stripped and HOME pointed at the auth file's
  // parent dir so Codex resolves the intended OAuth state instead of the current user's
  // default ~/.codex directory.
  const env = {
    ...process.env,
    PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    CODEX_AUTH_PATH: authPath,
    HOME: dirname(dirname(authPath)),
  };
  delete env.OPENAI_API_KEY;

  try {
    const { stdout, stderr } = await execFileAsync(
      CODEX_CLI,
      ['login', 'status'],
      { env, timeout: 10_000 }
    );
    const text = `${stdout || ''}\n${stderr || ''}`.toLowerCase();
    if (text.includes('api key')) {
      throw new OAuthError('codex', `Codex CLI still reports API-key auth while probing ${authPath}`);
    }
    if (text.includes('not logged in') || text.includes('logged out') || text.includes('login required')) {
      throw new OAuthError('codex', `Codex CLI reports not logged in for ${authPath}`);
    }
    if (!text.includes('chatgpt')) {
      throw new OAuthError('codex', `unexpected login status output for ${authPath}: ${(stdout || stderr).trim()}`);
    }
  } catch (err) {
    if (err?.isOAuthError) throw err;
    const msg = (err.message || '') + (err.stderr || '') + (err.stdout || '');
    if (msg.toLowerCase().includes('not logged in') || msg.toLowerCase().includes('login required')) {
      throw new OAuthError('codex', `CLI returned auth error: ${msg.substring(0, 200)}`);
    }
    throw new OAuthError('codex', `codex CLI login-status probe failed: ${msg.substring(0, 200)}`);
  }
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

// ── Adversarial prompt (NON-NEGOTIABLE) ──────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
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

function ensureSection(text, heading) {
  const pattern = new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}$`, 'mi');
  if (pattern.test(text)) return text;
  return `${text}\n\n## ${heading}\n- None.`.trim();
}

function normalizeIssueBullets(sectionBody) {
  const lines = sectionBody
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) return '- None.';
  if (lines.length === 1 && /^[-*]\s*none\.?$/i.test(lines[0])) return '- None.';

  const normalized = [];
  for (const line of lines) {
    if (/^[-*]\s+/u.test(line)) {
      normalized.push(`- ${line.replace(/^[-*]\s+/u, '')}`);
      continue;
    }
    if (/^(file|lines|problem|why it matters|recommended fix|verdict):/i.test(line)) {
      normalized.push(`  - ${line}`);
      continue;
    }
    normalized.push(`- ${line}`);
  }

  return normalized.join('\n');
}

function fallbackCodexReview(rawText) {
  const text = normalizeWhitespace(rawText);
  const summary = text ? text : '- None.';
  const verdict = /(request changes|comment only)/i.test(summary) ? summary.match(/(request changes|comment only)/i)?.[0] || 'Comment only' : 'Comment only';

  return [
    '## Summary',
    summary,
    '',
    '## Blocking issues',
    '- None.',
    '',
    '## Non-blocking issues',
    '- None.',
    '',
    '## Suggested fixes',
    '- None.',
    '',
    '## Verdict',
    verdict,
  ].join('\n').trim();
}

function formatCodexReview(reviewText) {
  const original = normalizeWhitespace(reviewText);
  let text = original;

  text = text
    .replace(/^#\s+/gm, '## ')
    .replace(/^###\s+/gm, '## ')
    .replace(/^####\s+/gm, '## ')
    .replace(/^##\s+(summary|blocking issues|non-blocking issues|suggested fixes|verdict)\s*:?$/gim, (_, heading) => `## ${titleCaseWords(heading)}`);

  const sectionRegex = /^##\s+(Summary|Blocking issues|Non-blocking issues|Suggested fixes|Verdict)\s*$/gim;
  const matches = [...text.matchAll(sectionRegex)];
  if (matches.length === 0) return fallbackCodexReview(original);

  const headingsFound = new Set(matches.map((m) => titleCaseWords(m[1])));
  const canonicalSections = [
    'Summary',
    'Blocking issues',
    'Non-blocking issues',
    'Suggested fixes',
    'Verdict',
  ];

  const rebuilt = [];
  for (let i = 0; i < matches.length; i += 1) {
    const heading = titleCaseWords(matches[i][1]);
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    const rawBody = normalizeWhitespace(text.slice(start, end));

    let body;
    if (heading === 'Summary' || heading === 'Verdict') {
      body = rawBody || '- None.';
      if (heading === 'Verdict' && !/(request changes|comment only)/i.test(body)) {
        body = `${body}\n\nComment only`.trim();
      }
    } else {
      body = normalizeIssueBullets(rawBody);
    }

    rebuilt.push(`## ${heading}\n${body}`.trim());
  }

  for (const heading of canonicalSections) {
    if (!headingsFound.has(heading)) {
      if (heading === 'Summary') {
        rebuilt.unshift(`## Summary\n${original || '- None.'}`.trim());
      } else if (heading === 'Verdict') {
        rebuilt.push('## Verdict\nComment only');
      } else {
        rebuilt.push(`## ${heading}\n- None.`);
      }
    }
  }

  return rebuilt.join('\n\n').trim();
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

// ── AI review via CLI (OAuth only) ──────────────────────────────────────────

/**
 * Run adversarial review using Claude Code CLI (OAuth).
 * ANTHROPIC_API_KEY is explicitly removed from the env so the CLI
 * uses its native OAuth path only. Preflight auth validation is aligned with
 * the broker/Keychain path used by the live stack.
 */
async function reviewWithClaude(diff) {
  await assertClaudeOAuth();

  const prompt = `${ADVERSARIAL_PROMPT}\n\n---\n\nHere is the PR diff to review:\n\n\`\`\`diff\n${diff}\`\`\``;

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
 */
async function reviewWithCodex(diff) {
  console.error('[reviewWithCodex] asserting OAuth...');
  await assertCodexOAuth();
  console.error('[reviewWithCodex] OAuth OK');

  if (!existsSync(ACPX_CLI)) {
    throw new Error(`ACPX CLI not found at ${ACPX_CLI}`);
  }

  const prompt = `${ADVERSARIAL_PROMPT}\n\n---\n\nHere is the PR diff to review:\n\n\`\`\`diff\n${diff}\`\`\``;

  const authPath = resolveCodexAuthPath();
  const env = {
    ...process.env,
    PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    CODEX_AUTH_PATH: authPath,
    HOME: dirname(dirname(authPath)),
  };
  delete env.OPENAI_API_KEY;

  const outputDir = join(process.env.HOME || '/Users/airlock', '.cache', 'codex-review');
  mkdirSync(outputDir, { recursive: true });
  const promptFile = join(outputDir, `review-prompt-${Date.now()}.txt`);

  writeFileSync(promptFile, prompt, 'utf8');

  let stdout = '';
  let stderr = '';
  try {
    console.error(`[reviewWithCodex] invoking ACPX with promptFile=${promptFile}`);
    const result = await execFileAsync(
      ACPX_CLI,
      ['codex', 'exec', '-f', promptFile],
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
    throw new Error(`ACPX Codex exec failed: ${msg.substring(0, 800)}`);
  } finally {
    if (existsSync(promptFile)) {
      rmSync(promptFile);
    }
  }

  console.error(`[reviewWithCodex] ACPX codex returned stdout length=${stdout.length}; stderr length=${stderr.length}`);

  const combined = normalizeWhitespace(stdout || stderr || '');
  if (!combined) {
    const hint = stderr?.trim() ? ` stderr: ${stderr.substring(0, 200)}` : '';
    throw new Error(`ACPX Codex returned empty output.${hint}`);
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

  // 2. Run adversarial review (OAuth only — no API key fallback)
  const effectiveModel = reviewerModel;

  let reviewText;
  try {
    console.error(`[reviewer] DEBUG: starting ${effectiveModel} review...`);
    if (effectiveModel === 'claude') {
      reviewText = await reviewWithClaude(diff);
    } else {
      reviewText = formatCodexReview(await reviewWithCodex(diff));
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
    await postGitHubReview(repo, prNumber, fullComment, botTokenEnv);
    console.log(`[reviewer] Review posted to ${repo}#${prNumber}`);
  } catch (err) {
    console.error(`[reviewer] Failed to post review to ${repo}#${prNumber}:`, err.message);
    process.exit(1);
  }

  // 4. Update Linear (LAC-13)
  const critical = isCritical(reviewText);
  try {
    await updateLinearTicket(linearTicketId, {
      reviewComplete: true,
      critical,
      reviewSummary: reviewText,
    });
  } catch (err) {
    console.error(`[reviewer] Linear update failed for ${linearTicketId}:`, err.message);
    // Non-fatal — review was posted, just log and continue
  }

  if (critical) {
    console.log(`[reviewer] CRITICAL issues detected in ${repo}#${prNumber} — Paul flagged in Linear`);
  }

  console.log(`[reviewer] Done: ${repo}#${prNumber}`);
}

main().catch((err) => {
  console.error('[reviewer] Unhandled error:', err);
  process.exit(1);
});
