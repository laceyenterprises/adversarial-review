import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const SUMMARY_MARKER = '@@WATCHER_CLAIM_LOOP_SUMMARY@@';

function fileUrl(...parts) {
  return pathToFileURL(path.join(REPO_ROOT, ...parts)).href;
}

function buildLoaderSource() {
  const reviewStateUrl = fileUrl('src', 'review-state.mjs');
  const reviewStateActualUrl = `${reviewStateUrl}?actual`;
  const subjectAdapterUrl = fileUrl('src', 'adapters', 'subject', 'github-pr', 'index.mjs');
  const packageParentUrl = fileUrl('package.json');

  const stubs = {
    [reviewStateUrl]: 'fixture:review-state',
    [subjectAdapterUrl]: 'fixture:subject-adapter',
    [fileUrl('src', 'adapters', 'operator', 'index.mjs')]: 'fixture:operator-surface',
    [fileUrl('src', 'adapters', 'reviewer-runtime', 'index.mjs')]: 'fixture:reviewer-runtime',
    [fileUrl('src', 'branch-protection.mjs')]: 'fixture:branch-protection',
    [fileUrl('src', 'adversarial-gate-status.mjs')]: 'fixture:adversarial-gate-status',
    [fileUrl('src', 'adversarial-gate-context.mjs')]: 'fixture:adversarial-gate-context',
    [fileUrl('src', 'follow-up-jobs.mjs')]: 'fixture:follow-up-jobs',
    [fileUrl('src', 'follow-up-merge-agent.mjs')]: 'fixture:follow-up-merge-agent',
    [fileUrl('src', 'follow-up-retrigger-label.mjs')]: 'fixture:follow-up-retrigger-label',
    [fileUrl('src', 'operator-retrigger-helpers.mjs')]: 'fixture:operator-retrigger-helpers',
    [fileUrl('src', 'reviewer-cascade.mjs')]: 'fixture:reviewer-cascade',
    [fileUrl('src', 'reviewer-reattach.mjs')]: 'fixture:reviewer-reattach',
    [fileUrl('src', 'reviewer-timeout.mjs')]: 'fixture:reviewer-timeout',
    [fileUrl('src', 'stale-drift.mjs')]: 'fixture:stale-drift',
    [fileUrl('src', 'watcher-fail-loud.mjs')]: 'fixture:watcher-fail-loud',
    [fileUrl('src', 'health-probe.mjs')]: 'fixture:health-probe',
  };

  return `
const stubs = new Map(${JSON.stringify(Object.entries(stubs))});

export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL?.startsWith('fixture:') && !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.includes(':')) {
    return nextResolve(specifier, { ...context, parentURL: ${JSON.stringify(packageParentUrl)} });
  }
  const resolved = await nextResolve(specifier, context);
  const stubUrl = stubs.get(resolved.url);
  if (stubUrl) return { url: stubUrl, shortCircuit: true };
  return resolved;
}

export async function load(url, context, nextLoad) {
  if (url === 'fixture:review-state') {
    return {
      format: 'module',
      shortCircuit: true,
      source: ${JSON.stringify(`
        import * as actual from ${JSON.stringify(reviewStateActualUrl)};
        import Database from 'better-sqlite3';
        let db = null;
        export * from ${JSON.stringify(reviewStateActualUrl)};
        export const ensureReviewStateSchema = actual.ensureReviewStateSchema;
        export function openReviewStateDb() {
          if (!db) {
            db = new Database(':memory:');
            actual.ensureReviewStateSchema(db);
            globalThis.__watcherClaimLoopDb = db;
          }
          return db;
        }
      `)}
    };
  }

  if (url === 'fixture:subject-adapter') {
    return {
      format: 'module',
      shortCircuit: true,
      source: ${JSON.stringify(`
        const REPO = 'laceyenterprises/adversarial-review';
        const subjects = [
          {
            ref: { domainId: 'code-pr', subjectExternalId: REPO + '#101', revisionRef: 'sha-happy-101' },
            lifecycle: 'pending-review',
            title: '[codex] LAC-636 happy path runtime claim',
            authorRef: 'codex-worker',
            builderClass: 'codex',
            labels: ['risk:medium'],
            updatedAt: '2026-05-15T12:00:00.000Z',
            headSha: 'sha-happy-101',
            terminal: false,
            observedAt: '2026-05-15T12:00:01.000Z',
          },
          {
            ref: { domainId: 'code-pr', subjectExternalId: REPO + '#102', revisionRef: null },
            lifecycle: 'pending-review',
            title: '[codex] LAC-636 null head sha runtime claim',
            authorRef: 'codex-worker',
            builderClass: 'codex',
            labels: ['risk:medium'],
            updatedAt: '2026-05-15T12:00:02.000Z',
            headSha: null,
            terminal: false,
            observedAt: '2026-05-15T12:00:03.000Z',
          },
          {
            ref: { domainId: 'code-pr', subjectExternalId: REPO + '#103', revisionRef: 'sha-missing-103' },
            missingDetail: true,
          },
        ];

        export function parseSubjectExternalId(subjectExternalId) {
          const match = String(subjectExternalId || '').match(/^([^#/]+\\/[^#/]+)#(\\d+)$/);
          if (!match) throw new TypeError('Invalid GitHub PR subjectExternalId: ' + subjectExternalId);
          return { repo: match[1], prNumber: Number(match[2]) };
        }

        export function makeSubjectExternalId(repo, prNumber) {
          return String(repo) + '#' + Number(prNumber);
        }

        export function revisionRefFromPR(pr) {
          return pr?.head?.sha || null;
        }

        export function stateFromSnapshot(snapshot) {
          return {
            ref: {
              domainId: snapshot.domainId || 'code-pr',
              subjectExternalId: snapshot.subjectExternalId,
              revisionRef: snapshot.revisionRef ?? snapshot.headSha ?? null,
            },
            lifecycle: snapshot.state && snapshot.state !== 'open' ? 'terminal' : 'pending-review',
            title: snapshot.title || '',
            authorRef: snapshot.authorRef,
            builderClass: snapshot.builderClass,
            labels: snapshot.labels || [],
            updatedAt: snapshot.updatedAt,
            headSha: snapshot.headSha ?? null,
            terminal: Boolean(snapshot.state && snapshot.state !== 'open'),
            observedAt: '2026-05-15T12:00:04.000Z',
          };
        }

        export function createGitHubPRSubjectAdapter({ octokit } = {}) {
          return {
            async discoverSubjects() {
              return subjects.map((subject) => subject.ref);
            },
            async fetchState(ref) {
              const subject = subjects.find((candidate) => candidate.ref.subjectExternalId === ref.subjectExternalId);
              if (!subject) throw new Error('unknown subject ' + ref.subjectExternalId);
              if (subject.missingDetail) {
                const { repo, prNumber } = parseSubjectExternalId(ref.subjectExternalId);
                const [owner, repoName] = repo.split('/');
                const detail = await octokit.rest.pulls.get({ owner, repo: repoName, pull_number: prNumber });
                if (detail.data !== null) throw new Error('missing-detail fixture expected null PR detail');
                return {
                  ref,
                  lifecycle: 'terminal',
                  title: '',
                  labels: [],
                  headSha: null,
                  terminal: true,
                  observedAt: '2026-05-15T12:00:05.000Z',
                };
              }
              return { ...subject, ref: { ...subject.ref } };
            },
          };
        }
      `)}
    };
  }

  if (url === 'fixture:operator-surface') {
    return {
      format: 'module',
      shortCircuit: true,
      source: "globalThis.__watcherClaimLoopOperatorWrites = []; export function createCompositeOperatorSurface() { return { extractLinearTicketId(title) { const match = String(title || '').match(/\\\\b(LAC-\\\\d+)\\\\b/i); return match ? match[1].toUpperCase() : null; }, syncTriageStatus: async (...args) => globalThis.__watcherClaimLoopOperatorWrites.push(args), observeOperatorApproved: async () => null, observeLabelControl: async () => null }; }"
    };
  }

  if (url === 'fixture:reviewer-runtime') {
    return {
      format: 'module',
      shortCircuit: true,
      source: "globalThis.__watcherClaimLoopReviewerSpawns = []; export function createReviewerRuntimeAdapterForDomain() { return { spawnReviewer: async (payload) => { globalThis.__watcherClaimLoopReviewerSpawns.push(payload); return { ok: true, stdout: '', stderr: '' }; }, cancel: async () => {} }; } export async function recoverReviewerRunRecords() { return { recovered: 0, failed: 0 }; }"
    };
  }

  const simpleStubs = {
    'fixture:branch-protection': "export function createBranchProtectionChecker() { return {}; } export async function warnForMissingAdversarialGateBranchProtection() {}",
    'fixture:adversarial-gate-status': "export function deleteGateRecordsForPR() {} export async function projectAdversarialGateStatus() { return { decision: { state: 'pending', reason: 'fixture' } }; }",
    'fixture:adversarial-gate-context': "export function resolveGateStatusContext() { return {}; }",
    'fixture:follow-up-jobs': "export function resolveRoundBudgetForJob() { return { roundBudget: 1, riskClass: 'medium' }; } export function summarizePRRemediationLedger() { return { completedRoundsForPR: 0, latestRiskClass: 'medium', latestMaxRounds: 1 }; }",
    'fixture:follow-up-merge-agent': "export function buildMergeAgentDispatchJob() { return null; } export async function dispatchMergeAgentForPR() { return { dispatched: false }; } export function fetchMergeAgentCandidate() { return null; }",
    'fixture:follow-up-retrigger-label': "export const RETRIGGER_REMEDIATION_LABEL = 'retrigger-remediation'; export async function retryPendingRetriggerAckComments() { return { attempted: 0, posted: 0 }; } export async function tryRetriggerRemediationFromLabel() { return { outcome: 'noop' }; }",
    'fixture:operator-retrigger-helpers': "export function findLatestFollowUpJob() { return null; }",
    'fixture:reviewer-cascade': "export const CASCADE_FAILURE_CAP = 3; export function classifyReviewerFailure() { return 'unknown'; } export function clearCascadeState() {} export function formatTransientFailureBreakdown() { return ''; } export function isReviewerSubprocessTimeout() { return false; } export function recordCascadeFailure() { return { consecutiveTransientFailures: 1, transientFailureBreakdown: {}, backoffMinutes: 1 }; } export function shouldBackoffReviewerSpawn() { return { shouldBackoff: false }; }",
    'fixture:reviewer-reattach': "export async function reconcileReviewerSessions() { return { reconciled: 0, skipped: 0 }; }",
    'fixture:reviewer-timeout': "export function resolveReviewerTimeoutMs() { return 300000; } export function resolveProgressTimeoutMs() { return 300000; }",
    'fixture:stale-drift': "export function shouldSkipReviewerForStaleDrift() { return null; }",
    'fixture:watcher-fail-loud': "export async function signalMalformedTitleFailure() { throw new Error('unexpected malformed-title path'); }",
    'fixture:health-probe': "export function createWatcherHealthProbe() { return { beginTick() { return {}; }, recordOpenPending() {}, recordSpawn() {}, async finishTick() {} }; }",
  };
  if (Object.prototype.hasOwnProperty.call(simpleStubs, url)) {
    return { format: 'module', shortCircuit: true, source: simpleStubs[url] };
  }

  return nextLoad(url, context);
}
`;
}

function buildRegisterSource(loaderPath) {
  return `
import { register } from 'node:module';

register(${JSON.stringify(pathToFileURL(loaderPath).href)}, import.meta.url);
`;
}

function buildRunnerSource() {
  const watcherUrl = fileUrl('src', 'watcher.mjs');
  return `
import assert from 'node:assert/strict';

const githubCalls = [];
const githubWrites = [];
const fetchCalls = [];
const claims = [];
globalThis.fetch = async (...args) => {
  fetchCalls.push(args.map(String));
  throw new Error('unexpected fetch call from watcher claim-loop test');
};
function readRows(db) {
  const rows = db.prepare(
    'SELECT repo, pr_number, review_status, reviewer_head_sha FROM reviewed_prs ORDER BY pr_number'
  ).all();
  return Object.fromEntries(rows.map((row) => [String(row.pr_number), row]));
}

try {
  const { pollOnce } = await import(${JSON.stringify(watcherUrl)});
  const db = globalThis.__watcherClaimLoopDb;
  assert.ok(db, 'watcher should have opened the synthetic in-memory DB');
  const insert = db.prepare(
    \`INSERT INTO reviewed_prs
       (repo, pr_number, reviewed_at, reviewer, pr_state, review_status, review_attempts)
     VALUES (?, ?, ?, ?, ?, ?, ?)\`
  );
  for (const [prNumber, reviewer] of [[101, 'claude'], [102, 'claude']]) {
    insert.run(
      'laceyenterprises/adversarial-review',
      prNumber,
      '2026-05-15T12:00:00.000Z',
      reviewer,
      'closed',
      'pending',
      0
    );
  }

  const octokit = {
    paginate: async (_fn, params) => {
      githubCalls.push({ kind: 'paginate', params });
      return [{ name: 'adversarial-review', archived: false }];
    },
    rest: {
      repos: {
        listForOrg: async () => {
          throw new Error('listForOrg should be reached through octokit.paginate only');
        },
      },
      pulls: {
        get: async (params) => {
          githubCalls.push({ kind: 'pulls.get', params });
          if (params.pull_number === 103) return { data: null };
          return {
            data: {
              number: params.pull_number,
              state: 'open',
              merged_at: null,
              closed_at: null,
              head: { sha: 'sha-detail-' + params.pull_number },
            },
          };
        },
        list: async (params) => {
          githubCalls.push({ kind: 'pulls.list', params });
          return { data: [] };
        },
      },
      issues: new Proxy({}, {
        get(_target, property) {
          return async (...args) => {
            githubWrites.push({ surface: 'issues', property: String(property), args });
            throw new Error('unexpected GitHub issues write');
          };
        },
      }),
    },
    request: async (...args) => {
      githubWrites.push({ surface: 'request', args });
      throw new Error('unexpected octokit.request call');
    },
  };

  await pollOnce(octokit, {
    healthProbe: {
      beginTick() { return {}; },
      recordOpenPending() {},
      recordSpawn() {},
      async finishTick() {},
    },
    afterClaim(payload) {
      claims.push(payload);
    },
  });

  console.log(${JSON.stringify(SUMMARY_MARKER)} + JSON.stringify({
    rows: readRows(db),
    claims,
    githubCalls,
    githubWrites,
    fetchCalls,
    operatorWrites: globalThis.__watcherClaimLoopOperatorWrites || [],
    reviewerSpawns: globalThis.__watcherClaimLoopReviewerSpawns || [],
  }));
} catch (err) {
  console.error(err?.stack || err?.message || err);
  process.exit(1);
}
`;
}

test('watcher pollOnce claim loop records subject-state head SHAs and drives the happy path', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'watcher-claim-loop-'));
  const loaderPath = path.join(tmp, 'fixture-loader.mjs');
  const registerPath = path.join(tmp, 'fixture-register.mjs');
  const runnerPath = path.join(tmp, 'fixture-runner.mjs');
  try {
    writeFileSync(loaderPath, buildLoaderSource());
    writeFileSync(registerPath, buildRegisterSource(loaderPath));
    writeFileSync(runnerPath, buildRunnerSource());

    const result = spawnSync(
      process.execPath,
      ['--no-warnings', '--import', pathToFileURL(registerPath).href, runnerPath],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          GITHUB_TOKEN: 'fixture-token',
        },
      }
    );

    const output = `${result.stdout || ''}${result.stderr || ''}`;
    assert.equal(result.status, 0, output);
    const summaryLine = result.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith(SUMMARY_MARKER));
    assert.ok(summaryLine, output);
    const summary = JSON.parse(summaryLine.slice(SUMMARY_MARKER.length));

    assert.equal(summary.rows['101'].review_status, 'posted');
    assert.equal(summary.rows['101'].reviewer_head_sha, 'sha-happy-101');
    assert.equal(summary.rows['102'].review_status, 'posted');
    assert.equal(summary.rows['102'].reviewer_head_sha, null);
    assert.deepEqual(
      summary.claims.map((claim) => [claim.prNumber, claim.reviewerHeadSha]),
      [
        [101, 'sha-happy-101'],
        [102, null],
      ]
    );
    assert.ok(
      summary.githubCalls.some((call) => call.kind === 'pulls.get' && call.params.pull_number === 103),
      'missing-PR detail edge should exercise the synthetic pulls.get fixture'
    );
    assert.deepEqual(summary.githubWrites, []);
    assert.deepEqual(summary.fetchCalls, []);
    assert.equal(summary.operatorWrites.length, 2);
    assert.deepEqual(
      summary.operatorWrites.map(([subjectRef, status]) => [subjectRef.subjectExternalId, status]),
      [
        ['laceyenterprises/adversarial-review#101', 'in-review'],
        ['laceyenterprises/adversarial-review#102', 'in-review'],
      ]
    );
    assert.equal(summary.reviewerSpawns.length, 2);
    assert.ok(
      summary.reviewerSpawns.every(Boolean),
      'happy-path subjects should spawn reviewer work after the claim'
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
