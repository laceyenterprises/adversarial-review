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
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ── CLI paths ────────────────────────────────────────────────────────────────

// Claude Code CLI — runs as the current user.
// Must NOT have ANTHROPIC_API_KEY in env when validating or invoking,
// otherwise the CLI may report API-key auth instead of its native login state.
const CLAUDE_CLI = '/opt/homebrew/bin/claude';

// Codex CLI binary lives under placey, but the reviewer itself runs as airlock.
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

/**
 * Verify airlock's Codex OAuth is set up (auth.json exists and is readable).
 */
function assertCodexAuthReadable() {
  const authPath = join(process.env.HOME || '/Users/airlock', '.codex', 'auth.json');
  if (!existsSync(authPath)) {
    throw new OAuthError('codex', `OAuth auth.json missing: ${authPath}`);
  }
  try {
    readFileSync(authPath, 'utf8');
  } catch (err) {
    throw new OAuthError('codex', `cannot read ${authPath}: ${err.message}`);
  }
}

async function assertCodexOAuth() {
  if (!existsSync(CODEX_CLI)) {
    throw new OAuthError('codex', `codex CLI not found at ${CODEX_CLI}`);
  }

  assertCodexAuthReadable();

  // Run login status with OPENAI_API_KEY stripped so Codex cannot fall back to API-key auth.
  const env = {
    ...process.env,
    PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
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
      throw new OAuthError('codex', 'Codex CLI still reports API-key auth');
    }
    if (text.includes('not logged in') || text.includes('logged out') || text.includes('login required')) {
      throw new OAuthError('codex', 'Codex CLI reports not logged in');
    }
    if (!text.includes('chatgpt')) {
      throw new OAuthError('codex', `unexpected login status output: ${(stdout || stderr).trim()}`);
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

const ADVERSARIAL_PROMPT = `You are performing an adversarial code review. You did NOT write this code.

Your job is to find problems. Specifically:
- Bugs and edge cases the author missed
- Security vulnerabilities (injections, auth gaps, secret leakage, unsafe deps)
- Design flaws (wrong abstraction, fragile coupling, missing error handling)
- Performance issues
- Anything that would fail in production

Do NOT summarize what the code does. Do NOT praise. Be specific and direct.
For each issue: state the file, line(s), the problem, and the recommended fix.

If you find nothing substantive, say so plainly — but look hard first.`;

// ── Critical-issue detection ─────────────────────────────────────────────────

const CRITICAL_WORDS = ['critical', 'vulnerability', 'security', 'injection'];

function isCritical(reviewText) {
  const lower = reviewText.toLowerCase();
  return CRITICAL_WORDS.some((w) => lower.includes(w));
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

  const prompt = `${ADVERSARIAL_PROMPT}\n\n---\n\nHere is the PR diff to review:\n\n\`\`\`diff\n${diff}\`\`\``;

  const env = {
    ...process.env,
    PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
  };
  delete env.OPENAI_API_KEY;

  const outputDir = join(process.env.HOME || '/Users/airlock', '.cache', 'codex-review');
  mkdirSync(outputDir, { recursive: true });
  const outputFile = join(outputDir, `review-${Date.now()}.txt`);

  const args = [
    '-a',
    'never',
    'exec',
    '--sandbox',
    'read-only',
    '--output-last-message',
    outputFile,
    prompt,
  ];

  console.error(`[reviewWithCodex] spawning codex with outputFile=${outputFile}`);

  const { code, stdout, stderr } = await new Promise((resolve, reject) => {
    const child = spawn(CODEX_CLI, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let finished = false;

    const timeout = setTimeout(() => {
      if (finished) return;
      finished = true;
      child.kill('SIGTERM');
      reject(new Error(`Codex CLI timed out after 300000ms. stderr: ${stderr.substring(0, 500)}`));
    }, 5 * 60 * 1000);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      reject(err);
    });
    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });

  console.error(`[reviewWithCodex] codex exited code=${code}; stdout length=${stdout.length}; stderr length=${stderr.length}`);

  let reviewText = '';
  try {
    if (existsSync(outputFile)) {
      reviewText = readFileSync(outputFile, 'utf8').trim();
      console.error(`[reviewWithCodex] read outputFile: ${reviewText.length} bytes`);
    } else {
      console.error('[reviewWithCodex] outputFile does not exist');
    }
  } finally {
    if (existsSync(outputFile)) {
      rmSync(outputFile);
    }
  }

  const msg = `${stderr || ''}\n${stdout || ''}`;
  if (msg.includes('401') || msg.includes('Unauthorized') || msg.includes('oauth') || msg.includes('login') || msg.includes('not logged in')) {
    throw new OAuthError('codex', `CLI returned auth error: ${msg.substring(0, 200)}`);
  }

  if (code !== 0) {
    throw new Error(`Codex CLI exited with code ${code}. stderr: ${stderr.substring(0, 500)}`);
  }

  if (reviewText) {
    return reviewText;
  }

  if (!stdout?.trim()) {
    const hint = stderr?.trim() ? ` stderr: ${stderr.substring(0, 200)}` : '';
    throw new Error(`Codex CLI returned empty output.${hint}`);
  }

  return stdout.trim();
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
      reviewText = await reviewWithCodex(diff);
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
