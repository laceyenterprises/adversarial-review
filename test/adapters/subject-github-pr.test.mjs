import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  createGitHubPRSubjectAdapter,
  makeSubjectExternalId,
  parseSubjectExternalId,
  revisionRefFromPR,
  stateFromSnapshot,
} from '../../src/adapters/subject/github-pr/index.mjs';
import { routeSubject } from '../../src/adapters/subject/github-pr/routing.mjs';

const fixture = JSON.parse(
  readFileSync(
    new URL('../fixtures/adapters/github-pr-snapshot.json', import.meta.url),
    'utf8'
  )
);

function makeOctokitSnapshot() {
  return {
    rest: {
      pulls: {
        list: async ({ owner, repo, state }) => {
          assert.equal(`${owner}/${repo}`, fixture.repo);
          assert.equal(state, 'open');
          return { data: fixture.pulls };
        },
        get: async ({ owner, repo, pull_number: pullNumber }) => {
          assert.equal(`${owner}/${repo}`, fixture.repo);
          assert.equal(pullNumber, fixture.pulls[0].number);
          return { data: fixture.pulls[0] };
        },
      },
    },
  };
}

test('github-pr subject adapter discovers GitHub PR subjects with normalized builderClass', async () => {
  const adapter = createGitHubPRSubjectAdapter({
    octokit: makeOctokitSnapshot(),
    repos: [fixture.repo],
    now: () => new Date('2026-05-10T21:30:00.000Z'),
  });

  const refs = await adapter.discoverSubjects();
  assert.deepEqual(refs.map(({ domainId, subjectExternalId, revisionRef }) => ({
    domainId,
    subjectExternalId,
    revisionRef,
  })), [{
    domainId: 'code-pr',
    subjectExternalId: `${fixture.repo}#484`,
    revisionRef: 'abc123def456',
  }]);

  const subject = await adapter.fetchState(refs[0]);
  assert.equal(subject.ref.domainId, 'code-pr');
  assert.equal(subject.ref.subjectExternalId, `${fixture.repo}#484`);
  assert.equal(subject.ref.revisionRef, 'abc123def456');
  assert.equal(subject.title, '[codex] LAC-484 carve subject channel adapter');
  assert.equal(subject.authorRef, 'codex-worker');
  assert.equal(subject.builderClass, 'codex');
  assert.deepEqual(subject.labels, ['risk:medium']);
  assert.equal(subject.updatedAt, '2026-05-10T21:20:00.000Z');
  assert.equal(subject.headSha, 'abc123def456');
  assert.equal(subject.terminal, false);
  assert.equal(subject.observedAt, '2026-05-10T21:30:00.000Z');
  assert.equal('pr' in subject, false);

  assert.deepEqual(routeSubject(subject), {
    builderClass: 'codex',
    tag: 'codex',
    reviewerModel: 'claude',
    botTokenEnv: 'GH_CLAUDE_REVIEWER_TOKEN',
  });
});

test('github-pr subject adapter fetches diff content through the subject interface', async () => {
  const calls = [];
  const adapter = createGitHubPRSubjectAdapter({
    octokit: makeOctokitSnapshot(),
    repos: [fixture.repo],
    execFileImpl: async (command, args, options = {}) => {
      calls.push({ command, args, options });
      return { stdout: fixture.diff, stderr: '' };
    },
    now: () => new Date('2026-05-10T21:31:00.000Z'),
  });
  const [ref] = await adapter.discoverSubjects();

  const content = await adapter.fetchContent(ref);

  assert.equal(content.ref.subjectExternalId, `${fixture.repo}#484`);
  assert.equal(content.ref.revisionRef, 'abc123def456');
  assert.equal(content.representation, fixture.diff);
  assert.deepEqual(content.contextFiles, []);
  assert.equal(content.observedAt, '2026-05-10T21:31:00.000Z');
  assert.deepEqual(calls.map((call) => [call.command, ...call.args]), [
    ['gh', 'pr', 'diff', '484', '--repo', fixture.repo],
  ]);
});

test('github-pr subject adapter prepares remediation workspace shape', async () => {
  const rootDir = '/tmp/subject-github-pr-fixture-root';
  const workspaceDir = path.join(rootDir, 'workspace');
  const adapter = createGitHubPRSubjectAdapter({
    octokit: makeOctokitSnapshot(),
    repos: [fixture.repo],
    rootDir,
    prepareWorkspaceForJobImpl: async ({ job }) => {
      assert.equal(job.jobId, 'job-484');
      assert.equal(job.repo, fixture.repo);
      assert.equal(job.prNumber, 484);
      return { workspaceDir, workspaceState: { action: 'reused', reason: 'fixture' } };
    },
    now: () => new Date('2026-05-10T21:32:00.000Z'),
  });
  const [ref] = await adapter.discoverSubjects();

  const workspace = await adapter.prepareRemediationWorkspace(ref, 'job-484');

  assert.deepEqual(workspace.ref, {
    domainId: 'code-pr',
    subjectExternalId: `${fixture.repo}#484`,
    revisionRef: 'abc123def456',
  });
  assert.equal(workspace.workspacePath, workspaceDir);
  assert.ok(workspace.instructions.some((line) => /PR branch/.test(line)));
  assert.equal(workspace.preparedAt, '2026-05-10T21:32:00.000Z');
});

test('github-pr subject identity helpers round-trip repo and number', () => {
  const externalId = makeSubjectExternalId('laceyenterprises/clio', 12);
  assert.equal(externalId, 'laceyenterprises/clio#12');
  assert.deepEqual(parseSubjectExternalId(externalId), {
    repo: 'laceyenterprises/clio',
    prNumber: 12,
  });
});

test('github-pr subject identity rejects malformed repo slugs', () => {
  assert.throws(
    () => parseSubjectExternalId('laceyenterprises/adversarial-review#extra#70'),
    /Invalid GitHub PR subjectExternalId/
  );
});

test('revisionRef only uses the real GitHub head SHA', () => {
  assert.equal(revisionRefFromPR({ number: 12, head: { sha: 'abc123', ref: 'branch-name' } }), 'abc123');
  assert.equal(revisionRefFromPR({ number: 12, head: { ref: 'branch-name' } }), null);
});

test('stateFromSnapshot always emits a boolean terminal flag', () => {
  const state = stateFromSnapshot({
    domainId: 'code-pr',
    subjectExternalId: 'laceyenterprises/clio#12',
    revisionRef: 'sha-1',
    title: 'Example',
    state: '',
    labels: [],
  });

  assert.equal(state.terminal, false);
  assert.equal(typeof state.terminal, 'boolean');
});

test('recordRemediationCommit reports commit revision without poisoning cached PR state', async () => {
  let getCalls = 0;
  const octokit = makeOctokitSnapshot();
  const originalGet = octokit.rest.pulls.get;
  octokit.rest.pulls.get = async (...args) => {
    getCalls += 1;
    return originalGet(...args);
  };
  const adapter = createGitHubPRSubjectAdapter({
    octokit,
    repos: [fixture.repo],
    now: () => new Date('2026-05-10T21:33:00.000Z'),
  });
  const [ref] = await adapter.discoverSubjects();

  const recorded = await adapter.recordRemediationCommit(ref, {
    ref,
    commitExternalId: 'commit-1',
    revisionRef: 'remediation-sha',
    committedAt: '2026-05-10T21:32:30.000Z',
  });
  const current = await adapter.fetchState(ref);

  assert.equal(getCalls, 0);
  assert.equal(recorded.ref.revisionRef, 'remediation-sha');
  assert.equal(current.ref.revisionRef, 'abc123def456');
});
