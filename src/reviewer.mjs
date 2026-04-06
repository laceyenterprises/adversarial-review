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

import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ── CLI paths ────────────────────────────────────────────────────────────────

// Claude Code CLI — runs as the current user; reads OAuth from ~/.claude/.credentials.json
// Must NOT have ANTHROPIC_API_KEY in env (would override OAuth)
const CLAUDE_CLI = '/opt/homebrew/bin/claude';

// Codex CLI — runs as placey; reads OAuth from ~/.codex/auth.json
const CODEX_CLI = '/Users/placey/.local/share/fnm/node-versions/v24.14.0/installation/bin/codex';

// ── OAuth credential checks ──────────────────────────────────────────────────

/**
 * Verify Claude OAuth credentials exist and are not expired.
 * Claude Code stores creds in ~/.claude/.credentials.json (host) or
 * the claude-credentials Docker volume (containers).
 * Throws with a descriptive message if creds are missing or expired.
 */
function assertClaudeOAuth() {
  const credPath = join(homedir(), '.claude', '.credentials.json');
  if (!existsSync(credPath)) {
    throw new OAuthError('claude', `~/.claude/.credentials.json not found — run 'claude' and log in`);
  }
  let creds;
  try {
    creds = JSON.parse(readFileSync(credPath, 'utf8'));
  } catch (err) {
    throw new OAuthError('claude', `Cannot parse ~/.claude/.credentials.json: ${err.message}`);
  }
  const oauth = creds?.claudeAiOauth;
  if (!oauth?.accessToken) {
    throw new OAuthError('claude', 'No OAuth access token in ~/.claude/.credentials.json');
  }
  if (oauth.expiresAt && Date.now() > oauth.expiresAt) {
    throw new OAuthError('claude', `OAuth token expired at ${new Date(oauth.expiresAt).toISOString()} — run 'claude' to refresh`);
  }
  if (!existsSync(CLAUDE_CLI)) {
    throw new OAuthError('claude', `claude CLI not found at ${CLAUDE_CLI}`);
  }
}

/**
 * Verify Codex OAuth credentials exist.
 * Codex stores auth in ~/.codex/auth.json (owned by placey).
 * We can't read it as airlock, so we do a lightweight CLI probe instead.
 */
async function assertCodexOAuth() {
  if (!existsSync(CODEX_CLI)) {
    throw new OAuthError('codex', `codex CLI not found at ${CODEX_CLI}`);
  }
  // Probe: run `codex --version` as placey — if it exits cleanly, CLI is functional
  // A missing/expired OAuth token won't show up here but will fail at inference time
  try {
    await execFileAsync(CODEX_CLI, ['--version'], { timeout: 10_000 });
  } catch (err) {
    throw new OAuthError('codex', `codex CLI failed version probe: ${err.message}`);
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
 * uses ~/.claude/.credentials.json OAuth tokens only.
 */
async function reviewWithClaude(diff) {
  assertClaudeOAuth();

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
  await assertCodexOAuth();

  const prompt = `${ADVERSARIAL_PROMPT}\n\n---\n\nHere is the PR diff to review:\n\n\`\`\`diff\n${diff}\`\`\``;

  const env = { ...process.env };
  delete env.OPENAI_API_KEY;

  let stdout, stderr;
  try {
    ({ stdout, stderr } = await execFileAsync(
      CODEX_CLI,
      ['--approval-policy', 'never', '--quiet', prompt],
      {
        env,
        timeout: 5 * 60 * 1000,
        maxBuffer: 10 * 1024 * 1024,
      }
    ));
  } catch (err) {
    const msg = (err.message || '') + (err.stderr || '');
    if (msg.includes('401') || msg.includes('Unauthorized') || msg.includes('oauth') || msg.includes('login')) {
      throw new OAuthError('codex', `CLI returned auth error: ${msg.substring(0, 200)}`);
    }
    throw err;
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

  // 1. Fetch diff
  let diff;
  try {
    diff = await fetchPRDiff(repo, prNumber);
  } catch (err) {
    console.error(`[reviewer] Failed to fetch diff for ${repo}#${prNumber}:`, err.message);
    process.exit(1);
  }

  if (!diff.trim()) {
    console.log(`[reviewer] Empty diff for ${repo}#${prNumber} — nothing to review`);
    process.exit(0);
  }

  // 2. Run adversarial review (OAuth only — no API key fallback)
  let reviewText;
  try {
    if (reviewerModel === 'claude') {
      reviewText = await reviewWithClaude(diff);
    } else {
      reviewText = await reviewWithCodex(diff);
    }
  } catch (err) {
    if (err.isOAuthError) {
      // OAuth failure — stop work and alert Paul
      await alertClioOAuthFailure(reviewerModel, repo, prNumber, err.message);
      console.error(`[reviewer] Stopped: OAuth credentials unavailable for ${reviewerModel}`);
      process.exit(2); // exit code 2 = auth failure (distinct from other errors)
    }
    console.error(`[reviewer] AI review failed for ${repo}#${prNumber}:`, err.message);
    process.exit(1);
  }

  console.log(`[reviewer] Review generated (${reviewText.length} chars)`);

  // 3. Post to GitHub
  const header =
    reviewerModel === 'claude'
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
