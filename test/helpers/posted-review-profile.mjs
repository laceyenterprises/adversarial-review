import { resolveGateStatusContext } from '../../src/adversarial-gate-context.mjs';
import Database from 'better-sqlite3';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { openReviewStateDb, ensureReviewStateSchema } from '../../src/review-state.mjs';
import { fetchReviewBodiesForHead } from '../../src/github-api.mjs';
import { withGitHubAdapterReadTick } from '../../src/github-adapter-client.mjs';

export const fixtureRepo = 'fixture/project';
export const fixtureHead = 'a'.repeat(40);
const body = '## Blocking Issues\n\n- None.\n\n## Non-blocking Issues\n\n- None.\n\n## Verdict\n\nComment only';
const fixtureGateContext = resolveGateStatusContext({});
const labels = ['operator-approved', 'merge-agent-requested', 'adversarial-merge-requested'];
const quiet = { log() {}, info() {}, warn() {}, error() {} };

// All I/O is synthetic. Counts cover real handler/gate/candidate/orchestration
// code. The daemon execution boundary is a lease refusal, never a live merge.
// Times are measured wall/SQL time plus an explicit per-exec delay, not a
// prediction of GitHub or adapter internals. Never log commands or payloads.
export async function profilePostedReviews(modules, { prCount = 15, delayMs = 20 } = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'posted-profile-'));
  const db = openReviewStateDb(rootDir);
  ensureReviewStateSchema(db);
  const row = { review_status: 'posted', reviewer_head_sha: fixtureHead,
    review_body: body, reviewer: 'codex' };
  const scope = new AsyncLocalStorage();
  const steps = {};
  const bucket = () => steps[scope.getStore() || 'handler-overhead'] ||= { runs: 0, wallMs: 0, samplesMs: [],
    github: {}, subprocesses: {}, database: { count: 0, ms: 0, migrationChecks: {} } };
  const timed = async (step, run) => scope.run(step, async () => {
    const entry = bucket();
    entry.runs++;
    const start = performance.now();
    try { return await run(); }
    finally {
      const elapsed = performance.now() - start;
      entry.wallMs += elapsed; entry.samplesMs.push(elapsed);
    }
  });
  const prepare = Database.prototype.prepare;
  Database.prototype.prepare = function (sql) {
    const statement = prepare.call(this, sql);
    if (!/^\s*(SELECT|PRAGMA)\b/i.test(sql)) return statement;
    return new Proxy(statement, { get(target, key) {
      const value = Reflect.get(target, key);
      if (typeof value !== 'function') return value;
      return (...args) => {
        if (!['get', 'all'].includes(key)) return value.apply(target, args);
        const entry = bucket().database;
        const start = performance.now();
        entry.count++;
        const migration = sql === 'SELECT 1 FROM schema_migrations WHERE id = ?' ? args[0]
          : sql === 'PRAGMA table_info(waits_by_class)' ? 'waits_by_class.last_paged' : null;
        if (migration) {
          entry.migrationChecks[migration] = (entry.migrationChecks[migration] || 0) + 1;
        }
        try { return value.apply(target, args); }
        finally { entry.ms += performance.now() - start; }
      };
    } });
  };
  let active = 0, peak = 0;
  let reviewerLogin = 'fixture-reviewer';
  const execFileImpl = async (command, args) => {
    const stats = bucket();
    const child = command === 'gh' ? 'gh' : 'adapter';
    const spawn = stats.subprocesses[child] ||= { count: 0, ms: 0 };
    spawn.count++;
    const start = performance.now();
    active++; peak = Math.max(peak, active);
    let kind;
    try {
      if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
      if (command !== 'gh') {
        if (args[0] === 'write') return { stdout: JSON.stringify({ ok: true }) };
        throw Object.assign(new Error('synthetic unsupported read'), { code: 78,
          // Mirror the adapter contract: requested names the invoked subcommand,
          // exercising the client's per-tick capability cache.
          stdout: JSON.stringify({ failureClass: 'unsupported', code: 'unsupported_command', requested: args[0] }) });
      }
      let value;
      if (args[0] === 'pr') {
        kind = 'gh:pr-view';
        value = { headRefOid: fixtureHead, headRefName: 'fixture-branch', baseRefName: 'main',
          baseRefOid: 'b'.repeat(40), state: 'OPEN', mergeable: 'MERGEABLE',
          mergeStateStatus: 'CLEAN', title: 'Synthetic change', labels,
          author: { login: 'fixture-builder' }, statusCheckRollup: Array.from({ length: 12 }, (_, i) =>
            ({ name: i === 0 ? fixtureGateContext : `check-${i}`, status: 'COMPLETED', conclusion: 'SUCCESS' })) };
      } else if (args.includes('graphql')) {
        kind = 'graphql:label-timeline';
        value = { data: { repository: { pullRequest: { headRefOid: fixtureHead,
          timelineItems: { nodes: [
            { __typename: 'PullRequestCommit', id: 'anchor', commit: { oid: fixtureHead,
              committedDate: '2026-01-01T00:00:00Z' } },
            ...labels.map(label => ({ __typename: 'LabeledEvent', id: `event-${label}`,
              label: { name: label }, actor: { login: 'fixture-operator' }, createdAt: '2026-01-01T00:01:00Z' })),
          ] } } } } };
      } else {
        const path = args.find(arg => arg.startsWith('repos/'));
        if (path?.includes('/protection')) {
          kind = 'rest:branch-protection';
          value = { required_status_checks: { contexts: [fixtureGateContext] } };
        } else if (path?.includes('/reviews')) {
          kind = 'rest:reviews-page';
          value = path.includes('page=2') ? [] : Array.from({ length: 100 }, () => ({
            user: { login: reviewerLogin }, commit_id: fixtureHead,
            submitted_at: '2026-01-01T00:02:00Z', state: 'COMMENTED', body,
          }));
        } else if (path?.includes('/pulls/')) {
          kind = 'rest:pr-state';
          value = { head: { sha: fixtureHead }, base: { ref: 'main', repo: { default_branch: 'main' } } };
        } else if (path?.includes('/statuses/')) {
          kind = 'rest:status-write'; value = {};
        } else throw new Error('unhandled synthetic endpoint');
      }
      return { stdout: JSON.stringify(value) };
    } finally {
      const ms = performance.now() - start;
      spawn.ms += ms;
      if (kind) {
        const endpoint = stats.github[kind] ||= { count: 0, ms: 0 };
        endpoint.count++; endpoint.ms += ms;
      }
      active--;
    }
  };
  const operatorSurface = modules.createGitHubPRLabelControlsAdapter({
    execFileImpl, fetchLatestLabelEventImpl: modules.fetchLatestLabelEvent,
  });
  const branchProtectionCache = new Map();
  const outcomes = [];
  const start = performance.now();
  try {
    await withGitHubAdapterReadTick(async () => {
      for (let prNumber = 1; prNumber <= prCount; prNumber++) {
        const result = await modules.handlePostedReviewRow({ rootDir, repoPath: fixtureRepo,
          prNumber, existing: row, currentRevisionRef: fixtureHead, labelNames: labels,
          domainId: 'code-pr', execFileImpl, operatorSurface, branchProtectionCache, reviewStateDb: db,
          currentReviewRowReader: () => db.prepare('SELECT 1').get() && row,
          projectGateStatusSafe: reviewRow => timed('projectGateStatusSafe', async () => {
            const approval = await operatorSurface.observeOperatorApproved({
              subjectExternalId: `${fixtureRepo}#${prNumber}` }, fixtureHead);
            return modules.projectAdversarialGateStatus(rootDir, { repo: fixtureRepo, prNumber,
              headSha: fixtureHead, labels, reviewRow, execFileImpl,
              operatorApprovalEvent: modules.legacyLabelEventFromControlResult(approval, 'operator-approved') });
          }),
          fetchMergeAgentCandidateImpl: (...args) => timed('fetchMergeAgentCandidate', () => modules.fetchMergeAgentCandidate(...args)),
          buildMergeAgentDispatchJobImpl: () => ({ blockingFindingCount: 0, blockingFindingState: 'known' }),
          resolveMergeAgentCoexistenceForWatcherImpl: options => timed('resolveMergeAgentCoexistence', () =>
            modules.resolveMergeAgentCoexistenceForWatcher({ ...options,
              maybeDispatchAmaClosureForImpl: options => modules.maybeDispatchAmaClosureFor({ ...options,
                loadConfigImpl: () => ({ getMergeAuthorityConfig: () => ({ enabled: true }),
                  getOrchestrationMode: () => 'native' }),
                fetchLatestHeadReviewBodiesImpl: (...args) => {
                  // Exercise the real authority filter without embedding any
                  // deployment account names in the synthetic fixture.
                  reviewerLogin = args[3].authoritativeReviewerLogins[0];
                  return fetchReviewBodiesForHead(execFileImpl, ...args);
                },
                runDaemonCleanMergeAttemptImpl: async () => ({ disposition: 'deferred', reason: 'fixture-lease-held' }),
              }),
              recoverOrphanImpl: async () => ({ handled: false }),
              recoverAmaAutomationImpl: async () => ({ outcome: 'ama-pending' }),
            })),
          latestFollowUpJobFinder: () => null, latestPostedReviewBodyFinder: () => body,
          logger: quiet,
        });
        outcomes.push({ handled: result?.handled, terminal: result?.prTerminal || false,
          outcome: result?.outcome, gateState: result?.gateDecision?.state,
          gateReason: result?.gateDecision?.reason, closureReason: result?.amaClosureResult?.reason });
      }
    }, { logger: quiet });
    for (const step of Object.values(steps)) {
      const samples = step.samplesMs.sort((a, b) => a - b);
      step.typicalMs = samples[Math.floor(samples.length / 2)] || 0;
      step.maxMs = samples.at(-1) || 0;
      delete step.samplesMs;
    }
    return { prCount, delayMs, wallMs: performance.now() - start, peak, steps, outcomes };
  } finally {
    Database.prototype.prepare = prepare;
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
}

// Three separate proof consumers of one immutable commit, each with its own
// operation deadline. This isolates the signal-aware history-cache cost from
// the ordinary current-head fixture above; mutable merge evidence is excluded.
export async function profileHistoryEvidence(modules, { prCount = 15, delayMs = 20 } = {}) {
  let calls = 0, ioMs = 0;
  const start = performance.now();
  const execGhWithRetryImpl = async () => {
    calls++;
    const started = performance.now();
    if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
    ioMs += performance.now() - started;
    return { stdout: JSON.stringify({ sha: fixtureHead, files: [], parents: [] }) };
  };
  for (let prNumber = 1; prNumber <= prCount; prNumber++) {
    await modules.withClosureEvaluationReadCache(async () => {
      for (let consumer = 0; consumer < 3; consumer++) {
        await modules.createHistoryReader({ execGhWithRetryImpl,
          signal: new AbortController().signal })(`repos/${fixtureRepo}/commits/${fixtureHead}`);
      }
    });
  }
  return { prCount, consumersPerPr: 3, wallMs: performance.now() - start,
    github: { 'rest:commit-page': { count: calls, ms: ioMs } },
    subprocesses: { gh: calls, hq: 0, node: 0 }, database: { count: 0, ms: 0 } };
}
