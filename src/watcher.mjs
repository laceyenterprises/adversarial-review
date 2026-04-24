/**
 * LAC-11: PR Watcher
 * Polls GitHub every N minutes for new agent-built PRs and spawns reviewer agents.
 * Also tracks PR lifecycle (merged/closed) and syncs status to Linear automatically.
 */

import { Octokit } from '@octokit/rest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  routePR,
} from './watcher-title-guardrails.mjs';
import { signalMalformedTitleFailure } from './watcher-fail-loud.mjs';
import { ensureReviewStateSchema, openReviewStateDb } from './review-state.mjs';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const config = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'));

// ── DB setup ────────────────────────────────────────────────────────────────

const db = openReviewStateDb(ROOT);
ensureReviewStateSchema(db);

const stmtGetReviewRow = db.prepare(
  'SELECT * FROM reviewed_prs WHERE repo = ? AND pr_number = ?'
);
const stmtCreateReviewRow = db.prepare(
  'INSERT OR IGNORE INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, pr_state, linear_ticket, review_status, review_attempts) VALUES (?, ?, ?, ?, ?, ?, ?, 0)'
);
const stmtUpdateReviewRouting = db.prepare(
  'UPDATE reviewed_prs SET reviewer = ?, linear_ticket = COALESCE(?, linear_ticket) WHERE repo = ? AND pr_number = ?'
);
const stmtMarkMalformed = db.prepare(
  "UPDATE reviewed_prs SET reviewer = 'malformed-title', review_status = 'malformed', failure_message = ?, failed_at = ?, last_attempted_at = ?, review_attempts = review_attempts + 1 WHERE repo = ? AND pr_number = ?"
);
const stmtMarkAttemptStarted = db.prepare(
  "UPDATE reviewed_prs SET review_status = 'pending', last_attempted_at = ?, failed_at = NULL, failure_message = NULL WHERE repo = ? AND pr_number = ?"
);
const stmtMarkPosted = db.prepare(
  "UPDATE reviewed_prs SET review_status = 'posted', posted_at = ?, failed_at = NULL, failure_message = NULL, review_attempts = review_attempts + 1 WHERE repo = ? AND pr_number = ?"
);
const stmtMarkFailed = db.prepare(
  "UPDATE reviewed_prs SET review_status = 'failed', failed_at = ?, failure_message = ?, review_attempts = review_attempts + 1 WHERE repo = ? AND pr_number = ?"
);
const stmtGetOpenPRs = db.prepare(
  "SELECT repo, pr_number, linear_ticket FROM reviewed_prs WHERE pr_state = 'open'"
);
const stmtMarkMerged = db.prepare(
  "UPDATE reviewed_prs SET pr_state = 'merged', merged_at = ? WHERE repo = ? AND pr_number = ?"
);
const stmtMarkClosed = db.prepare(
  "UPDATE reviewed_prs SET pr_state = 'closed', closed_at = ? WHERE repo = ? AND pr_number = ?"
);

// ── Author tag detection ─────────────────────────────────────────────────────

// ── Linear ticket extraction ─────────────────────────────────────────────────

function extractLinearTicketId(prTitle) {
  const match = prTitle.match(/\b(LAC-\d+)\b/i);
  return match ? match[1].toUpperCase() : null;
}

function resolveCodexReviewerEnv(reviewerEnv) {
  const sourceDir = process.env.CODEX_SOURCE_HOME || '/Users/placey/.codex';
  const sourceAuthPath = join(sourceDir, 'auth.json');

  reviewerEnv.HOME = reviewerEnv.HOME || '/Users/airlock';
  reviewerEnv.CODEX_AUTH_PATH = sourceAuthPath;
  reviewerEnv.CODEX_SOURCE_HOME = sourceDir;
  delete reviewerEnv.OPENAI_API_KEY;

  return { authPath: sourceAuthPath, home: reviewerEnv.HOME };
}

// ── Reviewer spawning ────────────────────────────────────────────────────────

async function spawnReviewer({ repo, prNumber, reviewerModel, botTokenEnv, linearTicketId }) {
  const reviewerPath = join(__dirname, 'reviewer.mjs');
  const args = JSON.stringify({ repo, prNumber, reviewerModel, botTokenEnv, linearTicketId });

  console.log(`[watcher] Spawning reviewer for ${repo}#${prNumber} (model: ${reviewerModel})`);

  try {
    const reviewerEnv = { ...process.env };

    if (String(reviewerModel || '').toLowerCase().includes('codex')) {
      const { authPath, home } = resolveCodexReviewerEnv(reviewerEnv);
      console.log(`[watcher] Using Codex auth for reviewer at ${authPath} with HOME=${home}`);
    }

    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [reviewerPath, args],
      { env: reviewerEnv, timeout: 5 * 60 * 1000 }
    );
    if (stdout) console.log(`[reviewer:${prNumber}] ${stdout.trim()}`);
    if (stderr) console.error(`[reviewer:${prNumber}] stderr: ${stderr.trim()}`);
    return { ok: true };
  } catch (err) {
    const detail = [err.message, err.stdout, err.stderr]
      .filter(Boolean)
      .join('\n')
      .trim()
      .slice(0, 4000);
    console.error(`[watcher] Reviewer failed for ${repo}#${prNumber}:`, detail || err.message);
    return { ok: false, error: detail || err.message };
  }
}

// ── Linear state helpers ─────────────────────────────────────────────────────

let linearClient = null;

async function getLinearClient() {
  if (!process.env.LINEAR_API_KEY) return null;
  if (!linearClient) {
    const { LinearClient } = await import('@linear/sdk');
    linearClient = new LinearClient({ apiKey: process.env.LINEAR_API_KEY });
  }
  return linearClient;
}

async function setLinearState(ticketId, targetStateName) {
  if (!ticketId) return;
  const linear = await getLinearClient();
  if (!linear) return;

  try {
    const issue = await linear.issue(ticketId);
    if (!issue) return;

    const team = await issue.team;
    const states = await team.states();
    const targetState = states.nodes.find(
      (s) => s.name.toLowerCase() === targetStateName.toLowerCase()
    );
    if (!targetState) {
      console.warn(`[watcher] Linear state "${targetStateName}" not found for team`);
      return;
    }

    const currentState = await issue.state;
    if (currentState?.name?.toLowerCase() === targetStateName.toLowerCase()) {
      console.log(`[watcher] Linear ${ticketId} already in "${targetStateName}" — skipping`);
      return;
    }

    await linear.updateIssue(issue.id, { stateId: targetState.id });
    console.log(`[watcher] Linear ${ticketId} → "${targetStateName}"`);
  } catch (err) {
    console.error(`[watcher] Linear update failed for ${ticketId} (→ ${targetStateName}):`, err.message);
  }
}

// Convenience wrappers using configurable state names
const linearStates = {
  inReview:   config.linearStates?.inReview   ?? 'In Review',
  done:       config.linearStates?.done       ?? 'Done',
  cancelled:  config.linearStates?.cancelled  ?? 'Cancelled',
};

const setLinearInReview  = (id) => setLinearState(id, linearStates.inReview);
const setLinearDone      = (id) => setLinearState(id, linearStates.done);
const setLinearCancelled = (id) => setLinearState(id, linearStates.cancelled);

// ── prlt linear sync ─────────────────────────────────────────────────────────

const PRLT_HQ = config.prltHq ?? '/Users/placey/prlt-hq/Laceyenterprises-hq';
const PRLT_BIN = config.prltBin ?? '/opt/homebrew/bin/prlt';

async function runPrltSync() {
  if (!process.env.LINEAR_API_KEY) return;

  try {
    const { stdout, stderr } = await execFileAsync(
      PRLT_BIN,
      ['linear', 'sync', '--machine'],
      {
        cwd: PRLT_HQ,
        env: { ...process.env },
        timeout: 60_000,
      }
    );
    const result = JSON.parse(stdout || '{}');
    const synced = result?.result?.synced ?? result?.result?.tickets?.length ?? '?';
    console.log(`[watcher] prlt linear sync complete — ${synced} ticket(s) synced`);
    if (stderr) console.warn(`[watcher] prlt sync stderr: ${stderr.trim()}`);
  } catch (err) {
    // Non-fatal — log and continue
    console.error(`[watcher] prlt linear sync failed:`, err.message);
  }
}

// ── Org repo discovery ───────────────────────────────────────────────────────

let activeRepos = config.repos ?? [];
let lastRepoRefresh = 0;

async function refreshOrgRepos(octokit) {
  if (!config.org) return;

  const now = Date.now();
  const refreshInterval = config.repoRefreshIntervalMs ?? 3_600_000;
  if (now - lastRepoRefresh < refreshInterval) return;

  try {
    const all = await octokit.paginate(octokit.rest.repos.listForOrg, {
      org: config.org,
      type: 'all',
      per_page: 100,
    });

    const excluded = new Set(config.excludeRepos ?? []);
    activeRepos = all
      .filter((r) => !r.archived && !excluded.has(r.name) && !excluded.has(`${config.org}/${r.name}`))
      .map((r) => `${config.org}/${r.name}`);

    lastRepoRefresh = now;
    console.log(`[watcher] Org repos refreshed — watching ${activeRepos.length} repos: ${activeRepos.join(', ')}`);
  } catch (err) {
    console.error(`[watcher] Failed to list org repos for ${config.org}:`, err.message);
  }
}

// ── Lifecycle sync: check open PRs for merge/close ──────────────────────────

/**
 * For every PR we previously marked as "open", check if it has since been
 * merged or closed and update Linear accordingly.
 */
async function syncPRLifecycle(octokit) {
  const openRows = stmtGetOpenPRs.all();
  if (openRows.length === 0) return;

  let anyChanged = false;

  for (const row of openRows) {
    const { repo, pr_number: prNumber, linear_ticket: linearTicketId } = row;
    const [owner, repoName] = repo.split('/');

    let pr;
    try {
      const { data } = await octokit.rest.pulls.get({ owner, repo: repoName, pull_number: prNumber });
      pr = data;
    } catch (err) {
      console.error(`[watcher] Failed to fetch PR ${repo}#${prNumber}:`, err.message);
      continue;
    }

    if (pr.merged_at) {
      console.log(`[watcher] PR ${repo}#${prNumber} was merged — syncing Linear`);
      stmtMarkMerged.run(pr.merged_at, repo, prNumber);
      await setLinearDone(linearTicketId);
      anyChanged = true;
    } else if (pr.state === 'closed') {
      console.log(`[watcher] PR ${repo}#${prNumber} was closed (unmerged) — syncing Linear`);
      stmtMarkClosed.run(pr.closed_at ?? new Date().toISOString(), repo, prNumber);
      await setLinearCancelled(linearTicketId);
      anyChanged = true;
    }
    // Still open → nothing to do
  }

  // If anything changed, run prlt sync to keep prlt's DB in step
  if (anyChanged) {
    await runPrltSync();
  }
}

// ── Poll loop (new PRs) ──────────────────────────────────────────────────────

async function pollOnce(octokit) {
  await refreshOrgRepos(octokit);

  // Check lifecycle of previously-seen PRs first
  await syncPRLifecycle(octokit);

  for (const repoPath of activeRepos) {
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
      const existing = stmtGetReviewRow.get(repoPath, prNumber);

      if (existing?.review_status === 'posted' || existing?.review_status === 'malformed') {
        continue;
      }

      const route = routePR(prTitle);
      if (!route) {
        if (!existing) {
          stmtCreateReviewRow.run(
            repoPath,
            prNumber,
            new Date().toISOString(),
            'malformed-title',
            'open',
            null,
            'pending'
          );
        }

        await signalMalformedTitleFailure(octokit, {
          repoPath,
          owner,
          repo,
          prNumber,
          prTitle,
        });

        // Malformed titles are terminal in watcher state to avoid ambiguous retitle retries.
        const failureAt = new Date().toISOString();
        stmtMarkMalformed.run(
          `Malformed PR title: ${prTitle}`,
          failureAt,
          failureAt,
          repoPath,
          prNumber
        );
        continue;
      }

      const linearTicketId = extractLinearTicketId(prTitle);
      if (!existing) {
        console.log(
          `[watcher] New PR ${repoPath}#${prNumber}: "${prTitle}" → ${route.reviewerModel}` +
            (linearTicketId ? ` (${linearTicketId})` : '')
        );
        stmtCreateReviewRow.run(
          repoPath,
          prNumber,
          new Date().toISOString(),
          route.reviewerModel,
          'open',
          linearTicketId,
          'pending'
        );
      } else {
        console.log(
          `[watcher] Retrying PR ${repoPath}#${prNumber}: "${prTitle}" → ${route.reviewerModel}` +
            (linearTicketId ? ` (${linearTicketId})` : '') +
            ` | previous status=${existing.review_status}`
        );
        stmtUpdateReviewRouting.run(route.reviewerModel, linearTicketId, repoPath, prNumber);
      }

      const attemptAt = new Date().toISOString();
      stmtMarkAttemptStarted.run(attemptAt, repoPath, prNumber);
      await setLinearInReview(linearTicketId);

      const result = await spawnReviewer({
        repo: repoPath,
        prNumber,
        reviewerModel: route.reviewerModel,
        botTokenEnv: route.botTokenEnv,
        linearTicketId,
      });

      if (result.ok) {
        stmtMarkPosted.run(new Date().toISOString(), repoPath, prNumber);
      } else {
        stmtMarkFailed.run(new Date().toISOString(), result.error || 'Unknown reviewer failure', repoPath, prNumber);
      }

      // Sync prlt after each new PR picked up
      await runPrltSync();
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

function main() {
  requireEnv('GITHUB_TOKEN');

  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
  const intervalMs = config.pollIntervalMs ?? 300_000;

  if (Object.prototype.hasOwnProperty.call(config, 'fallbackReviewer')) {
    console.error(
      '[watcher] config.fallbackReviewer is no longer supported. Remove it from config.json; malformed titles now fail loud and are never auto-routed.'
    );
    process.exit(1);
  }

  const watchMode = config.org
    ? `org: ${config.org} (dynamic discovery, refresh every ${(config.repoRefreshIntervalMs ?? 3_600_000) / 60_000}m)`
    : `repos: ${activeRepos.join(', ')}`;
  console.log(`[watcher] Starting — ${watchMode} | poll interval: ${intervalMs / 1000}s`);

  pollOnce(octokit).catch((err) => console.error('[watcher] Poll error:', err));

  setInterval(() => {
    pollOnce(octokit).catch((err) => console.error('[watcher] Poll error:', err));
  }, intervalMs);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main();
}

export {
  pollOnce,
};
