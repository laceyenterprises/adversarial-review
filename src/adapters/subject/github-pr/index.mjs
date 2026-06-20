/**
 * GitHub Pull Request implementation of the subject-channel adapter.
 *
 * @typedef {import('../../../kernel/contracts.d.ts').SubjectChannelAdapter} SubjectChannelAdapter
 * @typedef {import('../../../kernel/contracts.d.ts').SubjectRef} SubjectRef
 * @typedef {import('../../../kernel/contracts.d.ts').SubjectState} SubjectState
 * @typedef {import('../../../kernel/contracts.d.ts').SubjectContent} SubjectContent
 * @typedef {import('../../../kernel/contracts.d.ts').RemediationWorkspace} RemediationWorkspace
 * @typedef {import('../../../kernel/contracts.d.ts').RemediationCommitMetadata} RemediationCommitMetadata
 */

import { execFile } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { apiStatusFromError } from '../../../api-telemetry.mjs';
import { prepareWorkspaceForJob as defaultPrepareWorkspaceForJob } from '../../../follow-up-remediation.mjs';
import {
  readAdapterOpenPullRequests,
  readAdapterPullRequest,
  readAdapterPullRequestDiff,
  resolveGitHubAdapterBin,
} from '../../../github-adapter-client.mjs';
import { awaitThrottleIfNeeded, extractRateLimitObservation, recordResponseRateLimit } from '../../../rate-limit-throttle.mjs';
import { builderClassFromTitle } from './title-tagging.mjs';

const execFileAsync = promisify(execFile);
const DOMAIN_ID = 'code-pr';

function makeSubjectExternalId(repo, prNumber) {
  const normalizedRepo = String(repo || '').trim();
  const normalizedPrNumber = Number(prNumber);
  if (!normalizedRepo || !Number.isInteger(normalizedPrNumber) || normalizedPrNumber <= 0) {
    throw new TypeError(`Invalid GitHub PR subject identity: ${repo}#${prNumber}`);
  }
  return `${normalizedRepo}#${normalizedPrNumber}`;
}

function parseSubjectExternalId(subjectExternalId) {
  const raw = String(subjectExternalId || '').trim();
  const match = /^([^#/]+\/[^#/]+)#(\d+)$/.exec(raw);
  if (!match) {
    throw new TypeError(`Invalid GitHub PR subjectExternalId: ${subjectExternalId}`);
  }
  splitRepo(match[1]);
  return {
    repo: match[1],
    prNumber: Number(match[2]),
  };
}

function splitRepo(repoPath) {
  const [owner, repo] = String(repoPath || '').split('/');
  if (!owner || !repo) {
    throw new TypeError(`Invalid GitHub repo slug: ${repoPath}`);
  }
  return { owner, repo };
}

function headShaFromPR(pr) {
  return pr?.head?.sha || pr?.headRefOid || pr?.headSha
    ? String(pr?.head?.sha || pr?.headRefOid || pr?.headSha)
    : null;
}

function revisionRefFromPR(pr) {
  return headShaFromPR(pr);
}

function refFromPR(repoPath, pr) {
  return {
    domainId: DOMAIN_ID,
    subjectExternalId: makeSubjectExternalId(repoPath, pr?.number),
    revisionRef: revisionRefFromPR(pr),
  };
}

function normalizePRSnapshot(repoPath, pr) {
  const ref = refFromPR(repoPath, pr);
  const builderClass = builderClassFromTitle(pr?.title);
  return {
    ...ref,
    repo: repoPath,
    prNumber: Number(pr.number),
    title: String(pr?.title || ''),
    state: String(pr?.state || '').trim().toLowerCase(),
    headSha: headShaFromPR(pr) || undefined,
    labels: Array.isArray(pr?.labels)
      ? pr.labels
        .map((label) => (typeof label === 'string' ? label : label?.name))
        .filter((label) => typeof label === 'string' && label.trim())
        .map((label) => label.trim())
      : [],
    createdAt: pr?.created_at || pr?.createdAt ? String(pr.created_at || pr.createdAt) : undefined,
    updatedAt: pr?.updated_at || pr?.updatedAt ? String(pr.updated_at || pr.updatedAt) : undefined,
    authorRef: pr?.user?.login || pr?.author?.login ? String(pr?.user?.login || pr?.author?.login) : undefined,
    builderClass,
  };
}

function stateFromSnapshot(snapshot, {
  currentRound = 0,
  completedRemediationRounds = 0,
  maxRemediationRounds = 0,
  observedAt = new Date().toISOString(),
} = {}) {
  const terminal = Boolean(snapshot.state) && snapshot.state !== 'open';
  return {
    ref: {
      domainId: snapshot.domainId,
      subjectExternalId: snapshot.subjectExternalId,
      revisionRef: snapshot.revisionRef,
    },
    lifecycle: terminal ? 'terminal' : 'pending-review',
    title: snapshot.title,
    authorRef: snapshot.authorRef,
    builderClass: snapshot.builderClass || undefined,
    labels: snapshot.labels,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    headSha: snapshot.headSha,
    currentRound,
    completedRemediationRounds,
    maxRemediationRounds,
    terminal,
    observedAt,
  };
}

/**
 * @param {{
 *   octokit?: any,
 *   repos?: readonly string[],
 *   rootDir?: string,
 *   execFileImpl?: typeof execFileAsync,
 *   prepareWorkspaceForJobImpl?: Function,
 *   now?: () => Date,
 *   monotonicNowMs?: () => number,
 *   env?: NodeJS.ProcessEnv,
 * }} options
 * @returns {SubjectChannelAdapter}
 */
// Per-snapshot cache TTL. Within a single watcher tick, multiple call
// sites (fetchState, fetchContent, freshness re-checks) may hit the
// same PR; the cache coalesces them and avoids a duplicate `pulls.get`.
// But ticks are NOT short — when one PR's reviewer takes 5+ min to
// spawn, later PRs in the serial loop were being evaluated against the
// snapshot warmed at tick-start, with labels and head_sha that were
// already minutes stale. The retrigger-review label-check and the
// auto-refresh-stale guard both compared cached values, so labels
// applied mid-tick and pushes that landed mid-tick were invisible
// until the NEXT tick. With long ticks chaining back-to-back, an
// operator's retrigger-review label could sit unconsumed for an hour
// or more — the symptom reported on 2026-05-18.
//
// 30s is well above the same-iteration coalescing window (typically
// <1s between adapter calls for a single PR) and well below typical
// reviewer-spawn delays. Override via SUBJECT_ADAPTER_CACHE_TTL_MS.
const DEFAULT_SUBJECT_CACHE_TTL_MS = 30_000;

function resolveSubjectCacheTtlMs(env = process.env) {
  const raw = env?.SUBJECT_ADAPTER_CACHE_TTL_MS;
  if (raw === undefined || raw === null || raw === '') {
    return DEFAULT_SUBJECT_CACHE_TTL_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_SUBJECT_CACHE_TTL_MS;
  }
  return parsed;
}

function telemetryStatusFromResult(result) {
  if (Number.isFinite(Number(result?.status))) return Math.trunc(Number(result.status));
  return 200;
}

function createGitHubPRSubjectAdapter({
  octokit,
  repos = [],
  rootDir,
  execFileImpl = execFileAsync,
  prepareWorkspaceForJobImpl = null,
  now = () => new Date(),
  monotonicNowMs = () => performance.now(),
  cacheTtlMs = resolveSubjectCacheTtlMs(),
  recordApiCall = null,
  env = process.env,
} = {}) {
  // Per-adapter-instance scratch cache. Entries carry a monotonic
  // fetch timestamp and are rejected on read once older than
  // `cacheTtlMs` (default 30s, overridable via
  // SUBJECT_ADAPTER_CACHE_TTL_MS). The cache is per subject, not per
  // revisionRef: within TTL, the newest snapshot we have for that PR is
  // authoritative even when callers keep using an older SubjectRef.
  const snapshotBySubjectExternalId = new Map();

  function setCache(snapshot) {
    snapshot._fetchedAtMonotonicMs = monotonicNowMs();
    snapshotBySubjectExternalId.set(snapshot.subjectExternalId, snapshot);
  }

  function getFreshCache(subjectExternalId) {
    const cached = snapshotBySubjectExternalId.get(subjectExternalId);
    if (!cached) return null;
    // `>=` so cacheTtlMs=0 disables caching outright (always miss) —
    // useful as an operator escape hatch via SUBJECT_ADAPTER_CACHE_TTL_MS=0
    // if the TTL logic ever needs to be neutralized.
    const ageMs = monotonicNowMs() - (cached._fetchedAtMonotonicMs ?? 0);
    if (ageMs >= cacheTtlMs) return null;
    return cached;
  }

  function hasGitHubAdapter() {
    return Boolean(resolveGitHubAdapterBin({ env, rootDir }));
  }

  async function withApiTelemetry(category, {
    repo = null,
    prNumber = null,
    extra = null,
    recordNullResult = true,
  } = {}, action) {
    const startedAt = monotonicNowMs();
    try {
      await awaitThrottleIfNeeded();
      const result = await action();
      await recordResponseRateLimit(extractRateLimitObservation(result?.headers));
      if (recordNullResult || (result !== null && result !== undefined)) {
        recordApiCall?.({
          category,
          repo,
          prNumber,
          status: telemetryStatusFromResult(result),
          durationMs: monotonicNowMs() - startedAt,
          ...(extra ? { extra } : {}),
        });
      }
      return result;
    } catch (err) {
      await recordResponseRateLimit(extractRateLimitObservation(err?.response?.headers));
      recordApiCall?.({
        category,
        repo,
        prNumber,
        status: apiStatusFromError(err),
        durationMs: monotonicNowMs() - startedAt,
        ...(extra ? { extra } : {}),
      });
      throw err;
    }
  }

  async function withAdapterTelemetry(category, details, action) {
    if (!hasGitHubAdapter()) return null;
    return withApiTelemetry(category, {
      ...details,
      extra: { transport: 'github-adapter' },
      recordNullResult: false,
    }, action);
  }

  async function fetchPRSnapshot(ref) {
    const { repo, prNumber } = parseSubjectExternalId(ref.subjectExternalId);
    const cached = getFreshCache(ref.subjectExternalId);
    if (cached) return cached;
    try {
      const adapterPr = await withAdapterTelemetry('pr_view', {
        repo,
        prNumber,
      }, () => readAdapterPullRequest(repo, prNumber, { execFileImpl, rootDir, env }));
      if (adapterPr) {
        const snapshot = normalizePRSnapshot(repo, adapterPr);
        setCache(snapshot);
        return snapshot;
      }
    } catch {
      // The common adapter is optional during rollout; fall back to Octokit.
    }
    if (!octokit?.rest?.pulls?.get) {
      throw new Error(`No GitHub client available to fetch ${ref.subjectExternalId}`);
    }
    const { owner, repo: repoName } = splitRepo(repo);
    const { data } = await withApiTelemetry('pr_view', { repo, prNumber }, () => octokit.rest.pulls.get({
      owner,
      repo: repoName,
      pull_number: prNumber,
    }));
    const snapshot = normalizePRSnapshot(repo, data);
    setCache(snapshot);
    return snapshot;
  }

  return {
    async discoverSubjects() {
      const refs = [];
      for (const repoPath of repos) {
        const { owner, repo } = splitRepo(repoPath);
        let adapterPulls = null;
        try {
          adapterPulls = await withAdapterTelemetry('pr_view', {
            repo: repoPath,
          }, () => readAdapterOpenPullRequests(repoPath, { execFileImpl, rootDir, env }));
        } catch {
          adapterPulls = null;
        }
        if (Array.isArray(adapterPulls) && (adapterPulls.length > 0 || !octokit?.rest?.pulls?.list)) {
          for (const pr of adapterPulls) {
            const snapshot = normalizePRSnapshot(repoPath, pr);
            setCache(snapshot);
            refs.push({
              domainId: snapshot.domainId,
              subjectExternalId: snapshot.subjectExternalId,
              revisionRef: snapshot.revisionRef,
            });
          }
          continue;
        }
        if (!octokit?.rest?.pulls?.list) {
          throw new Error('No GitHub client available to discover GitHub PR subjects');
        }
        const { data } = await withApiTelemetry('pr_view', { repo: repoPath }, () => octokit.rest.pulls.list({
          owner,
          repo,
          state: 'open',
          per_page: 50,
          sort: 'created',
          direction: 'desc',
        }));
        for (const pr of data) {
          const snapshot = normalizePRSnapshot(repoPath, pr);
          setCache(snapshot);
          refs.push({
            domainId: snapshot.domainId,
            subjectExternalId: snapshot.subjectExternalId,
            revisionRef: snapshot.revisionRef,
          });
        }
      }
      return refs;
    },

    async fetchState(ref) {
      const snapshot = await fetchPRSnapshot(ref);
      return stateFromSnapshot(snapshot, { observedAt: now().toISOString() });
    },

    async fetchContent(ref) {
      const snapshot = await fetchPRSnapshot(ref);
      let stdout;
      let adapterDiff = null;
      try {
        adapterDiff = await withAdapterTelemetry('diff_fetch', {
          repo: snapshot.repo,
          prNumber: snapshot.prNumber,
        }, () => readAdapterPullRequestDiff(snapshot.repo, snapshot.prNumber, { execFileImpl, rootDir, env }));
      } catch {
        // The common adapter is optional during rollout; fall back to gh.
        adapterDiff = null;
      }
      if (adapterDiff !== null) {
        stdout = adapterDiff;
      } else {
        ({ stdout } = await withApiTelemetry('diff_fetch', {
          repo: snapshot.repo,
          prNumber: snapshot.prNumber,
        }, () => execFileImpl('gh', [
          'pr',
          'diff',
          String(snapshot.prNumber),
          '--repo',
          snapshot.repo,
        ], {
          maxBuffer: 10 * 1024 * 1024,
        })));
      }
      return {
        ref: {
          domainId: snapshot.domainId,
          subjectExternalId: snapshot.subjectExternalId,
          revisionRef: snapshot.revisionRef,
        },
        representation: String(stdout || ''),
        contextFiles: [],
        observedAt: now().toISOString(),
      };
    },

    async prepareRemediationWorkspace(ref, jobId) {
      const snapshot = await fetchPRSnapshot(ref);
      const prepareWorkspace = prepareWorkspaceForJobImpl || defaultPrepareWorkspaceForJob;
      const { workspaceDir } = await prepareWorkspace({
        rootDir,
        job: {
          jobId,
          repo: snapshot.repo,
          prNumber: snapshot.prNumber,
        },
        execFileImpl,
      });
      return {
        ref: {
          domainId: snapshot.domainId,
          subjectExternalId: snapshot.subjectExternalId,
          revisionRef: snapshot.revisionRef,
        },
        workspacePath: workspaceDir,
        instructions: [
          'Work on the PR branch checked out in this repository clone.',
          'Commit remediation changes and push the existing PR branch.',
        ],
        preparedAt: now().toISOString(),
      };
    },

    async recordRemediationCommit(ref, commit) {
      const snapshot = await fetchPRSnapshot(ref);
      return stateFromSnapshot({
        ...snapshot,
        revisionRef: commit?.revisionRef || snapshot.revisionRef,
      }, { observedAt: now().toISOString() });
    },

    async finalizeSubject(ref) {
      const snapshot = await fetchPRSnapshot(ref);
      return stateFromSnapshot({
        ...snapshot,
        state: snapshot.state || 'closed',
      }, { observedAt: now().toISOString() });
    },

    async isTerminal(ref) {
      const snapshot = await fetchPRSnapshot(ref);
      return Boolean(snapshot.state && snapshot.state !== 'open');
    },
  };
}

export {
  DOMAIN_ID,
  createGitHubPRSubjectAdapter,
  headShaFromPR,
  makeSubjectExternalId,
  normalizePRSnapshot,
  parseSubjectExternalId,
  refFromPR,
  revisionRefFromPR,
  stateFromSnapshot,
};
