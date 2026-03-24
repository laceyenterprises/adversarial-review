/**
 * LAC-11: PR Watcher
 * Polls GitHub every N minutes for new agent-built PRs and spawns reviewer agents.
 */

import { Octokit } from '@octokit/rest';
import Database from 'better-sqlite3';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const config = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'));

// ── DB setup ────────────────────────────────────────────────────────────────

mkdirSync(join(ROOT, 'data'), { recursive: true });
const db = new Database(join(ROOT, 'data', 'reviews.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS reviewed_prs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    repo       TEXT NOT NULL,
    pr_number  INTEGER NOT NULL,
    reviewed_at TEXT NOT NULL,
    reviewer   TEXT NOT NULL,
    UNIQUE(repo, pr_number)
  )
`);

const stmtIsReviewed = db.prepare(
  'SELECT 1 FROM reviewed_prs WHERE repo = ? AND pr_number = ?'
);
const stmtMarkReviewed = db.prepare(
  'INSERT OR IGNORE INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer) VALUES (?, ?, ?, ?)'
);

// ── Author tag detection ─────────────────────────────────────────────────────

const TAG_PATTERN = /^\[(claude-code|codex|clio-agent)\]/i;

/**
 * Returns { tag, reviewerModel, botTokenEnv } or null if skipped.
 */
function routePR(prTitle) {
  const match = prTitle.match(TAG_PATTERN);
  const tag = match ? match[1].toLowerCase() : null;

  if (!tag && !config.fallbackReviewer) return null;

  if (tag === 'codex') {
    return {
      tag,
      reviewerModel: 'claude',
      botTokenEnv: 'GH_CLAUDE_REVIEWER_TOKEN',
    };
  }

  // [claude-code], [clio-agent], or no tag (fallback → codex)
  return {
    tag: tag ?? 'fallback',
    reviewerModel: 'codex',
    botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN',
  };
}

// ── Linear ticket extraction ─────────────────────────────────────────────────

function extractLinearTicketId(prTitle) {
  const match = prTitle.match(/\b(LAC-\d+)\b/i);
  return match ? match[1].toUpperCase() : null;
}

// ── Reviewer spawning ────────────────────────────────────────────────────────

async function spawnReviewer({ repo, prNumber, reviewerModel, botTokenEnv, linearTicketId }) {
  const reviewerPath = join(__dirname, 'reviewer.mjs');
  const args = JSON.stringify({ repo, prNumber, reviewerModel, botTokenEnv, linearTicketId });

  console.log(`[watcher] Spawning reviewer for ${repo}#${prNumber} (model: ${reviewerModel})`);

  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [reviewerPath, args],
      { env: process.env, timeout: 5 * 60 * 1000 }
    );
    if (stdout) console.log(`[reviewer:${prNumber}] ${stdout.trim()}`);
    if (stderr) console.error(`[reviewer:${prNumber}] stderr: ${stderr.trim()}`);
  } catch (err) {
    console.error(`[watcher] Reviewer failed for ${repo}#${prNumber}:`, err.message);
    // Don't rethrow — watcher keeps running
    return false;
  }
  return true;
}

// ── Linear: set PR to "In Review" ───────────────────────────────────────────

async function setLinearInReview(ticketId) {
  if (!ticketId || !process.env.LINEAR_API_KEY) return;

  try {
    const { LinearClient } = await import('@linear/sdk');
    const linear = new LinearClient({ apiKey: process.env.LINEAR_API_KEY });
    const issue = await linear.issue(ticketId);
    if (!issue) return;

    const team = await issue.team;
    const states = await team.states();
    const inReviewState = states.nodes.find(
      (s) => s.name.toLowerCase() === 'in review'
    );
    if (inReviewState) {
      await linear.updateIssue(issue.id, { stateId: inReviewState.id });
      console.log(`[watcher] Linear ${ticketId} → In Review`);
    }
  } catch (err) {
    console.error(`[watcher] Linear update failed for ${ticketId}:`, err.message);
  }
}

// ── Poll loop ────────────────────────────────────────────────────────────────

async function pollOnce(octokit) {
  for (const repoPath of config.repos) {
    const [owner, repo] = repoPath.split('/');

    let prs;
    try {
      const { data } = await octokit.rest.pulls.list({
        owner,
        repo,
        state: 'open',
        per_page: 50,
        sort: 'created',
        direction: 'desc',
      });
      prs = data;
    } catch (err) {
      console.error(`[watcher] Failed to fetch PRs for ${repoPath}:`, err.message);
      continue;
    }

    for (const pr of prs) {
      const prNumber = pr.number;
      const prTitle = pr.title;

      // Already reviewed?
      if (stmtIsReviewed.get(repoPath, prNumber)) {
        continue;
      }

      // Route by tag
      const route = routePR(prTitle);
      if (!route) {
        // No tag and no fallback — skip
        console.log(`[watcher] Skipping ${repoPath}#${prNumber} — no agent tag`);
        continue;
      }

      const linearTicketId = extractLinearTicketId(prTitle);
      console.log(
        `[watcher] New PR ${repoPath}#${prNumber}: "${prTitle}" → ${route.reviewerModel}` +
          (linearTicketId ? ` (${linearTicketId})` : '')
      );

      // Mark as reviewed before spawning to avoid duplicate spawns on next cycle
      stmtMarkReviewed.run(repoPath, prNumber, new Date().toISOString(), route.reviewerModel);

      // Set Linear ticket to "In Review"
      await setLinearInReview(linearTicketId);

      // Spawn reviewer (non-blocking relative to other PRs — but we await each
      // to avoid hammering APIs with many concurrent reviews)
      await spawnReviewer({
        repo: repoPath,
        prNumber,
        reviewerModel: route.reviewerModel,
        botTokenEnv: route.botTokenEnv,
        linearTicketId,
      });
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

function requireEnv(name) {
  if (!process.env[name]) {
    console.error(`[watcher] Missing required env var: ${name}`);
    process.exit(1);
  }
}

requireEnv('GITHUB_TOKEN');

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const intervalMs = config.pollIntervalMs ?? 300_000;

console.log(
  `[watcher] Starting — repos: ${config.repos.join(', ')} | interval: ${intervalMs / 1000}s`
);

// Run immediately, then on interval
pollOnce(octokit).catch((err) => console.error('[watcher] Poll error:', err));

setInterval(() => {
  pollOnce(octokit).catch((err) => console.error('[watcher] Poll error:', err));
}, intervalMs);
