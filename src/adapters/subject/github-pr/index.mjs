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
import { promisify } from 'node:util';
import { prepareWorkspaceForJob as defaultPrepareWorkspaceForJob } from '../../../follow-up-remediation.mjs';
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
  return pr?.head?.sha ? String(pr.head.sha) : null;
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
    updatedAt: pr?.updated_at ? String(pr.updated_at) : undefined,
    authorRef: pr?.user?.login ? String(pr.user.login) : undefined,
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
 * }} options
 * @returns {SubjectChannelAdapter}
 */
function createGitHubPRSubjectAdapter({
  octokit,
  repos = [],
  rootDir,
  execFileImpl = execFileAsync,
  prepareWorkspaceForJobImpl = null,
  now = () => new Date(),
} = {}) {
  // Per-adapter-instance scratch cache: discoverSubjects() warms it so the
  // matching fetchState()/fetchContent() calls in the same watcher poll do not
  // re-fetch PRs. It is not intended as a cross-poll freshness cache.
  const snapshotBySubjectExternalId = new Map();

  async function fetchPRSnapshot(ref) {
    const { repo, prNumber } = parseSubjectExternalId(ref.subjectExternalId);
    const cached = snapshotBySubjectExternalId.get(ref.subjectExternalId);
    if (cached && (!ref.revisionRef || cached.revisionRef === ref.revisionRef)) {
      return cached;
    }
    if (!octokit?.rest?.pulls?.get) {
      throw new Error(`No GitHub client available to fetch ${ref.subjectExternalId}`);
    }
    const { owner, repo: repoName } = splitRepo(repo);
    const { data } = await octokit.rest.pulls.get({
      owner,
      repo: repoName,
      pull_number: prNumber,
    });
    const snapshot = normalizePRSnapshot(repo, data);
    snapshotBySubjectExternalId.set(snapshot.subjectExternalId, snapshot);
    return snapshot;
  }

  return {
    async discoverSubjects() {
      if (!octokit?.rest?.pulls?.list) {
        throw new Error('No GitHub client available to discover GitHub PR subjects');
      }

      const refs = [];
      for (const repoPath of repos) {
        const { owner, repo } = splitRepo(repoPath);
        const { data } = await octokit.rest.pulls.list({
          owner,
          repo,
          state: 'open',
          per_page: 50,
          sort: 'created',
          direction: 'desc',
        });
        for (const pr of data) {
          const snapshot = normalizePRSnapshot(repoPath, pr);
          snapshotBySubjectExternalId.set(snapshot.subjectExternalId, snapshot);
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
      const { stdout } = await execFileImpl('gh', [
        'pr',
        'diff',
        String(snapshot.prNumber),
        '--repo',
        snapshot.repo,
      ], {
        maxBuffer: 10 * 1024 * 1024,
      });
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
