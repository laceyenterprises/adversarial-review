/**
 * LAC-11: PR Watcher
 * Polls GitHub every N minutes for new agent-built PRs and spawns reviewer agents.
 * Also tracks PR lifecycle (merged/closed) and syncs status to Linear automatically.
 */

import { Octokit } from '@octokit/rest';
import Database from 'better-sqlite3';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  buildMalformedTitleFailureComment,
  routePR,
} from './watcher-title-guardrails.mjs';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const config = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'));

// ── DB setup ────────────────────────────────────────────────────────────────

mkdirSync(join(ROOT, 'data'), { recursive: true });
const db = new Database(join(ROOT, 'data', 'reviews.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS reviewed_prs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    repo        TEXT NOT NULL,
    pr_number   INTEGER NOT NULL,
    reviewed_at TEXT NOT NULL,
    reviewer    TEXT NOT NULL,
    pr_state    TEXT NOT NULL DEFAULT 'open',
    merged_at   TEXT,
    closed_at   TEXT,
    linear_ticket TEXT,
    UNIQUE(repo, pr_number)
  )
`);

// Migrate existing rows that may be missing new columns (safe no-op if columns exist)
try { db.exec(`ALTER TABLE reviewed_prs ADD COLUMN pr_state TEXT NOT NULL DEFAULT 'open'`); } catch (_) {}
try { db.exec(`ALTER TABLE reviewed_prs ADD COLUMN merged_at TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE reviewed_prs ADD COLUMN closed_at TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE reviewed_prs ADD COLUMN linear_ticket TEXT`); } catch (_) {}

const stmtIsReviewed = db.prepare(
  'SELECT 1 FROM reviewed_prs WHERE repo = ? AND pr_number = ?'
);
const stmtMarkReviewed = db.prepare(
  'INSERT OR IGNORE INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, pr_state, linear_ticket) VALUES (?, ?, ?, ?, ?, ?)'
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
    return false;
  }
  return true;
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

// ── Fail-loud malformed-title signaling ─────────────────────────────────────

async function signalMalformedTitleFailure(octokit, { repoPath, owner, repo, prNumber, prTitle }) {
  const structuredFailure = {
    repo: repoPath,
    prNumber,
    title: prTitle,
    reason: 'missing-or-invalid-creation-time-reviewer-tag',
  };
  console.error(`[watcher] MALFORMED_PR_TITLE ${JSON.stringify(structuredFailure)}`);

  const body = buildMalformedTitleFailureComment({ prTitle });

  try {
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body,
    });
    console.error(`[watcher] Fail-loud comment posted for ${repoPath}#${prNumber}`);
  } catch (err) {
    console.error(`[watcher] Failed to post malformed-title comment for ${repoPath}#${prNumber}:`, err.message);
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

      if (stmtIsReviewed.get(repoPath, prNumber)) {
        continue;
      }

      const route = routePR(prTitle);
      if (!route) {
        await signalMalformedTitleFailure(octokit, {
          repoPath,
          owner,
          repo,
          prNumber,
          prTitle,
        });

        stmtMarkReviewed.run(
          repoPath,
          prNumber,
          new Date().toISOString(),
          'malformed-title',
          'malformed',
          null
        );
        continue;
      }

      const linearTicketId = extractLinearTicketId(prTitle);
      console.log(
        `[watcher] New PR ${repoPath}#${prNumber}: "${prTitle}" → ${route.reviewerModel}` +
          (linearTicketId ? ` (${linearTicketId})` : '')
      );

      stmtMarkReviewed.run(repoPath, prNumber, new Date().toISOString(), route.reviewerModel, 'open', linearTicketId);

      await setLinearInReview(linearTicketId);

      await spawnReviewer({
        repo: repoPath,
        prNumber,
        reviewerModel: route.reviewerModel,
        botTokenEnv: route.botTokenEnv,
        linearTicketId,
      });

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

  if (config.fallbackReviewer) {
    console.warn(
      '[watcher] config.fallbackReviewer is ignored: malformed/missing title tags now fail loud and do not auto-route.'
    );
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
  signalMalformedTitleFailure,
};
