import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createGitHubPRSubjectAdapter,
  makeSubjectExternalId,
  parseSubjectExternalId,
  revisionRefFromPR,
  stateFromSnapshot,
} from '../../src/adapters/subject/github-pr/index.mjs';
import {
  defaultReviewerRouteFromEnv,
  describeCrossModelReviewWaiver,
  isCrossModelReviewWaived,
  routePR,
  routeSubject,
} from '../../src/adapters/subject/github-pr/routing.mjs';
// CFG-09 (2026-05-30, round-2): role-config cascade cache is keyed by
// call shape (topPath + modulePaths), not env. The reviewer-routing
// tests here mutate env between cases (e.g. AGENT_OS_ROLES_REVIEWER
// values, canonical/legacy conflicts), so the cache must be dropped
// between cases to surface the per-test env. The side-effect import
// below auto-installs beforeEach + afterEach reset hooks for this
// file. Mid-test resets (line ~120 below) stay explicit because the
// boundary is inside a single test, not between tests.
import '../helpers/role-config-cache-reset.mjs';
import { resetRoleConfigCache } from '../../src/role-config.mjs';

const fixture = JSON.parse(
  readFileSync(
    new URL('../fixtures/adapters/github-pr-snapshot.json', import.meta.url),
    'utf8'
  )
);
const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const HERMETIC_CONFIG_ENV = { AGENT_OS_CONFIG_PATH: '/dev/null' };

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

test('github-pr routing can force the default reviewer from env', () => {
  const env = { ...HERMETIC_CONFIG_ENV, ADVERSARIAL_REVIEW_DEFAULT_REVIEWER: 'codex' };

  assert.deepEqual(routeSubject({ builderClass: 'codex' }, { env }), {
    builderClass: 'codex',
    tag: 'codex',
    reviewerModel: 'codex',
    botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN',
  });

  assert.deepEqual(routeSubject({ builderClass: 'claude-code' }, { env }), {
    builderClass: 'claude-code',
    tag: 'claude-code',
    reviewerModel: 'codex',
    botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN',
  });

  // CFG-09: this third assertion rotates env mid-test, which is the
  // documented boundary that requires an explicit cache reset. In
  // production this maps to a per-tick / per-job boundary; here it
  // maps to one cache drop between the env-flip and the next call.
  resetRoleConfigCache();
  assert.deepEqual(routePR('[codex] LAC-484 env default reviewer', null, {
    env: { ...HERMETIC_CONFIG_ENV, ADVERSARIAL_REVIEW_DEFAULT_REVIEWER: 'claude-code' },
  }), {
    builderClass: 'codex',
    tag: 'codex',
    reviewerModel: 'claude',
    botTokenEnv: 'GH_CLAUDE_REVIEWER_TOKEN',
    linearTicketId: 'LAC-484',
  });
});

test('github-pr routing extracts configured linear issue prefix', () => {
  resetRoleConfigCache();
  assert.deepEqual(routePR('[codex] ACME-484 env prefix', null, {
    env: { ...HERMETIC_CONFIG_ENV, AGENT_OS_LINEAR_ISSUE_PREFIX: 'ACME' },
  }), {
    builderClass: 'codex',
    tag: 'codex',
    reviewerModel: 'claude',
    botTokenEnv: 'GH_CLAUDE_REVIEWER_TOKEN',
    linearTicketId: 'ACME-484',
  });
});

test('github-pr routing extracts configured linear issue prefix from topPath', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'subject-github-pr-'));
  try {
    const topPath = path.join(tmp, 'config.yaml');
    writeFileSync(
      topPath,
      'version: 1\nlinear:\n  issue_prefix: ACME\n',
      'utf8',
    );
    resetRoleConfigCache();
    assert.deepEqual(routePR('[codex] ACME-484 file prefix', null, {
      topPath,
      env: {},
    }), {
      builderClass: 'codex',
      tag: 'codex',
      reviewerModel: 'claude',
      botTokenEnv: 'GH_CLAUDE_REVIEWER_TOKEN',
      linearTicketId: 'ACME-484',
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('github-pr routing surfaces config-broken sentinel for unknown reviewer env values', () => {
  // CFG-02 round-1 review B3 fix (2026-05-30): routeSubject no longer
  // throws on bad config — it returns a tagged sentinel so the watcher
  // can route to a "config-broken" disposition without aborting the
  // whole tick. The boot-time validator
  // (validateDefaultReviewerRouteConfig) remains the legitimate
  // fail-loud path; runtime edits during a tick go through this
  // sentinel.
  const route = routeSubject(
    { builderClass: 'codex' },
    { env: { ADVERSARIAL_REVIEW_DEFAULT_REVIEWER: 'unknown-reviewer', AGENT_OS_CONFIG_PATH: '/dev/null' } }
  );
  assert.equal(route.configBroken, true);
  assert.match(route.error.message, /ADVERSARIAL_REVIEW_DEFAULT_REVIEWER/);
  assert.match(route.error.message, /unknown-reviewer/);
});

test('github-pr routing exposes same-family review waiver detection for override pins', () => {
  assert.equal(isCrossModelReviewWaived('codex', 'codex'), true);
  assert.equal(isCrossModelReviewWaived('claude-code', 'claude'), true);
  // Clio dispatches codex workers, so its writer-family is codex. A codex
  // reviewer on a [clio-agent] PR is same-model (waived); a claude
  // reviewer is genuine cross-model (not waived).
  assert.equal(isCrossModelReviewWaived('clio-agent', 'codex'), true);
  assert.equal(isCrossModelReviewWaived('clio-agent', 'claude'), false);
  assert.equal(isCrossModelReviewWaived('codex', 'claude'), false);

  const reason = describeCrossModelReviewWaiver(
    'codex',
    'codex',
    { ADVERSARIAL_REVIEW_DEFAULT_REVIEWER: 'codex' }
  );
  assert.match(reason, /ADVERSARIAL_REVIEW_DEFAULT_REVIEWER="codex"/);
  assert.match(reason, /cross-model review guarantee is waived/i);
});

test('github-pr routing assigns supported MHX-09 builder tags to the expected cross-model reviewers', () => {
  assert.deepEqual(routePR('[gemini] LAC-484: route gemini', null, { env: HERMETIC_CONFIG_ENV }), {
    builderClass: 'gemini',
    tag: 'gemini',
    reviewerModel: 'codex',
    botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN',
    linearTicketId: 'LAC-484',
  });
  assert.deepEqual(routePR('[pi] LAC-484: route pi', null, { env: HERMETIC_CONFIG_ENV }), {
    builderClass: 'pi',
    tag: 'pi',
    reviewerModel: 'codex',
    botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN',
    linearTicketId: 'LAC-484',
  });
  assert.deepEqual(routePR('[hermes] LAC-484: route hermes', null, { env: HERMETIC_CONFIG_ENV }), {
    builderClass: 'hermes',
    tag: 'hermes',
    reviewerModel: 'codex',
    botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN',
    linearTicketId: 'LAC-484',
  });
});

test('github-pr routing startup validation rejects unknown default reviewer env values', () => {
  assert.throws(
    () => defaultReviewerRouteFromEnv({
      ADVERSARIAL_REVIEW_DEFAULT_REVIEWER: 'unknown-reviewer',
      AGENT_OS_CONFIG_PATH: '/dev/null',
    }),
    (err) => {
      assert.match(err.message, /ADVERSARIAL_REVIEW_DEFAULT_REVIEWER/);
      assert.match(err.message, /unknown-reviewer/);
      return true;
    }
  );
});

test('github-pr routing rejects unsupported opencode title prefixes', () => {
  assert.equal(routePR('[opencode] LAC-484: route opencode', null, { env: HERMETIC_CONFIG_ENV }), null);
});

test('watcher startup prints a fatal config banner for invalid default reviewer env values', () => {
  const result = spawnSync(
    process.execPath,
    ['src/watcher.mjs'],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        GITHUB_TOKEN: 'test-token',
        ADVERSARIAL_REVIEW_DEFAULT_REVIEWER: 'unknown-reviewer',
        AGENT_OS_CONFIG_PATH: '/dev/null',
      },
      encoding: 'utf8',
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /FATAL config/);
  assert.match(result.stderr, /ADVERSARIAL_REVIEW_DEFAULT_REVIEWER/);
  assert.match(result.stderr, /unknown-reviewer/);
});

test('watcher startup crashes with a fatal config banner for invalid fallback_path', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'watcher-hrr-02b-'));
  try {
    const top = path.join(tmp, 'config.yaml');
    writeFileSync(top, [
      'version: 1',
      'roles:',
      '  claude-code:',
      '    fallback_path: direct-api-key',
      '',
    ].join('\n'));

    const result = spawnSync(
      process.execPath,
      ['src/watcher.mjs'],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          GITHUB_TOKEN: 'test-token',
          AGENT_OS_CONFIG_PATH: top,
        },
        encoding: 'utf8',
      },
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /FATAL config/);
    assert.match(result.stderr, /roles\.claude-code\.fallback_path/);
    assert.match(result.stderr, /direct-api-key/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── CFG-02 cascade tests (env via canonical + legacy) ─────────────────────

test('CFG-02 routeSubject: canonical AGENT_OS_ROLES_REVIEWER pins reviewer', () => {
  assert.deepEqual(
    routeSubject(
      { builderClass: 'codex' },
      { env: { AGENT_OS_ROLES_REVIEWER: 'claude-code', AGENT_OS_CONFIG_PATH: '/dev/null' } },
    ),
    {
      builderClass: 'codex',
      tag: 'codex',
      reviewerModel: 'claude',
      botTokenEnv: 'GH_CLAUDE_REVIEWER_TOKEN',
    },
  );
});

test('CFG-02 routeSubject: canonical + legacy env conflict surfaces sentinel (§10.1 + B3 fix)', () => {
  // CFG-02 round-1 review B3 fix (2026-05-30): see preceding test's
  // comment. The fail-loud guarantee for env-alias conflict still holds
  // — but now via the config-broken sentinel rather than a throw, so
  // the watcher's per-PR loop doesn't abort.
  const route = routeSubject(
    { builderClass: 'codex' },
    {
      env: {
        AGENT_OS_ROLES_REVIEWER: 'codex',
        ADVERSARIAL_REVIEW_DEFAULT_REVIEWER: 'claude-code',
        AGENT_OS_CONFIG_PATH: '/dev/null',
      },
    },
  );
  assert.equal(route.configBroken, true);
  assert.match(route.error.message, /AGENT_OS_ROLES_REVIEWER/);
  assert.match(route.error.message, /ADVERSARIAL_REVIEW_DEFAULT_REVIEWER/);
  assert.match(route.error.message, /conflict/i);
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

// Regression for the 2026-05-18 incident where the watcher stopped
// consuming `retrigger-review` labels on long-running ticks. Root cause:
// the per-adapter snapshot cache, populated at tick-start by
// discoverSubjects(), never expired. After a 15-30 min reviewer-spawn
// chain inside one tick, fetchState() returned the original snapshot
// for every PR — so the retrigger-review label-check + auto-refresh-
// stale guard both saw stale labels and stale head_sha, and neither
// fired. Operators reported labels sitting unconsumed for hours; the
// pattern recurred across an entire weekend.

function makeAdapterClock() {
  // Mutable split clock so tests can independently model wall-clock
  // jumps and monotonic elapsed time.
  let wallMs = Date.parse('2026-05-18T12:07:00.000Z');
  let monotonicMs = 0;
  return {
    now: () => new Date(wallMs),
    monotonicNowMs: () => monotonicMs,
    advance(deltaMs) {
      wallMs += deltaMs;
      monotonicMs += deltaMs;
    },
    rewindWall(deltaMs) { wallMs -= deltaMs; },
    wallNowMs() { return wallMs; },
    monotonicMs() { return monotonicMs; },
  };
}

function makeMutableOctokit(initialPR) {
  // Octokit double whose `pulls.list` + `pulls.get` return the CURRENT
  // PR state at call time (not a snapshot). Tracks call counts so tests
  // can assert cache hits vs misses.
  let current = JSON.parse(JSON.stringify(initialPR));
  const calls = { list: 0, get: 0 };
  return {
    calls,
    setPR(next) { current = JSON.parse(JSON.stringify(next)); },
    octokit: {
      rest: {
        pulls: {
          list: async () => {
            calls.list += 1;
            return { data: [current] };
          },
          get: async () => {
            calls.get += 1;
            return { data: current };
          },
        },
      },
    },
  };
}

const REGRESSION_PR_BASE = {
  number: 661,
  title: '[codex] ADAG-13: comms-event DAG triggers',
  state: 'open',
  updated_at: '2026-05-18T04:08:48.000Z',
  head: { sha: '70194f3c82f6b37fb1b84bcc80f5ed5347d1e824', ref: 'codex-adag-13-r7/ADAG-13' },
  user: { login: 'codex-worker' },
  labels: [],
};

test('fetchState returns cached snapshot for back-to-back calls within TTL (coalescing preserved)', async () => {
  // Within a normal-cadence tick (sub-second back-to-back calls on the
  // same ref), the cache must still coalesce so we don\'t fire two
  // `pulls.get` requests for the same PR in the same loop iteration.
  const clock = makeAdapterClock();
  const mut = makeMutableOctokit(REGRESSION_PR_BASE);
  const adapter = createGitHubPRSubjectAdapter({
    octokit: mut.octokit,
    repos: ['laceyenterprises/agent-os'],
    now: clock.now,
    monotonicNowMs: clock.monotonicNowMs,
    cacheTtlMs: 30_000,
  });
  const [ref] = await adapter.discoverSubjects();
  assert.equal(mut.calls.list, 1);
  assert.equal(mut.calls.get, 0);

  // Same iteration → cached; no get.
  clock.advance(50);
  const s1 = await adapter.fetchState(ref);
  assert.equal(mut.calls.get, 0, 'fast back-to-back fetchState must hit cache');
  assert.deepEqual(s1.labels, []);

  clock.advance(200);
  const s2 = await adapter.fetchState(ref);
  assert.equal(mut.calls.get, 0, 'second fast fetchState must hit cache');
  assert.deepEqual(s2.labels, []);
});

test('REGRESSION 2026-05-18: fetchState re-fetches after cache TTL elapses (picks up labels applied mid-tick)', async () => {
  const clock = makeAdapterClock();
  const mut = makeMutableOctokit(REGRESSION_PR_BASE);
  const adapter = createGitHubPRSubjectAdapter({
    octokit: mut.octokit,
    repos: ['laceyenterprises/agent-os'],
    now: clock.now,
    monotonicNowMs: clock.monotonicNowMs,
    cacheTtlMs: 30_000,
  });
  const [ref] = await adapter.discoverSubjects();
  assert.deepEqual(
    (await adapter.fetchState(ref)).labels, [],
    'initial fetchState reflects the labels at tick-start',
  );

  // Simulate the operator applying the retrigger-review label and the
  // PR being force-pushed to a new head WHILE the watcher is busy
  // spawning a reviewer for some other PR.
  mut.setPR({
    ...REGRESSION_PR_BASE,
    head: { ...REGRESSION_PR_BASE.head, sha: 'eb7277e8e6f651e1627c1dd6af1ec1ad57362fe1' },
    labels: [{ name: 'retrigger-review' }],
  });

  // Less than TTL — still cached, still stale (intentional: short
  // back-to-back coalescing).
  clock.advance(15_000);
  const stillStale = await adapter.fetchState(ref);
  assert.deepEqual(stillStale.labels, [],
    'Under-TTL fetchState MUST return cached value to preserve coalescing');

  // Past TTL — must re-fetch.
  clock.advance(20_000);
  const fresh = await adapter.fetchState(ref);
  assert.deepEqual(fresh.labels, ['retrigger-review'],
    'Pre-fix bug: fetchState returned the stale cached snapshot indefinitely. '
    + 'Post-fix: after the 30s TTL elapses, fetchState must re-fetch and '
    + 'pick up labels applied mid-tick — the failure mode that masked '
    + 'retrigger-review labels for hours on 2026-05-18.');
  assert.equal(fresh.headSha, 'eb7277e8e6f651e1627c1dd6af1ec1ad57362fe1',
    'head_sha drift must also be picked up after TTL — the auto-refresh-'
    + 'stale guard depends on subject.headSha being current.');
  assert.equal(mut.calls.get, 1, 'exactly one pulls.get fired on the TTL miss');
});

test('TTL=0 disables caching entirely (every fetchState calls pulls.get)', async () => {
  // Belt-and-suspenders: operators can set
  // SUBJECT_ADAPTER_CACHE_TTL_MS=0 to disable the cache outright if
  // they suspect a regression. Pin that escape hatch works.
  const clock = makeAdapterClock();
  const mut = makeMutableOctokit(REGRESSION_PR_BASE);
  const adapter = createGitHubPRSubjectAdapter({
    octokit: mut.octokit,
    repos: ['laceyenterprises/agent-os'],
    now: clock.now,
    monotonicNowMs: clock.monotonicNowMs,
    cacheTtlMs: 0,
  });
  const [ref] = await adapter.discoverSubjects();
  assert.equal(mut.calls.list, 1);

  await adapter.fetchState(ref);
  await adapter.fetchState(ref);
  await adapter.fetchState(ref);
  assert.equal(mut.calls.get, 3,
    'TTL=0 must force a fresh pulls.get on every fetchState');
});

test('fetchContent within TTL also reuses the cached snapshot', async () => {
  // The same TTL applies to fetchContent's snapshot lookup so the
  // diff-fetch path doesn\'t double-fetch within the coalescing window.
  const clock = makeAdapterClock();
  const mut = makeMutableOctokit(REGRESSION_PR_BASE);
  const adapter = createGitHubPRSubjectAdapter({
    octokit: mut.octokit,
    repos: ['laceyenterprises/agent-os'],
    now: clock.now,
    monotonicNowMs: clock.monotonicNowMs,
    cacheTtlMs: 30_000,
    execFileImpl: async () => ({ stdout: 'diff --git fake\n' }),
  });
  const [ref] = await adapter.discoverSubjects();
  await adapter.fetchState(ref);
  await adapter.fetchContent(ref);
  assert.equal(mut.calls.get, 0,
    'fetchContent right after fetchState within TTL must hit cache (coalescing)');
});

test('REGRESSION 2026-05-18: cache TTL still expires after wall-clock rollback', async () => {
  const clock = makeAdapterClock();
  const mut = makeMutableOctokit(REGRESSION_PR_BASE);
  const adapter = createGitHubPRSubjectAdapter({
    octokit: mut.octokit,
    repos: ['laceyenterprises/agent-os'],
    now: clock.now,
    monotonicNowMs: clock.monotonicNowMs,
    cacheTtlMs: 30_000,
  });
  const [ref] = await adapter.discoverSubjects();
  await adapter.fetchState(ref);

  mut.setPR({
    ...REGRESSION_PR_BASE,
    head: { ...REGRESSION_PR_BASE.head, sha: '91dd3b75644fd0281e3d65fd97e6e2105b6b0db6' },
    labels: [{ name: 'retrigger-review' }],
  });

  clock.advance(10_000);
  clock.rewindWall(60_000);
  clock.advance(25_000);

  const fresh = await adapter.fetchState(ref);
  assert.deepEqual(fresh.labels, ['retrigger-review'],
    'TTL must follow monotonic elapsed time, not wall-clock rollback.');
  assert.equal(fresh.headSha, '91dd3b75644fd0281e3d65fd97e6e2105b6b0db6');
  assert.equal(mut.calls.get, 1, 'rollback path must still force one TTL refresh');
});

test('REGRESSION 2026-05-18: fresh cache snapshot is reused even when caller keeps the original SubjectRef', async () => {
  const clock = makeAdapterClock();
  const mut = makeMutableOctokit(REGRESSION_PR_BASE);
  let diffCalls = 0;
  const adapter = createGitHubPRSubjectAdapter({
    octokit: mut.octokit,
    repos: ['laceyenterprises/agent-os'],
    now: clock.now,
    monotonicNowMs: clock.monotonicNowMs,
    cacheTtlMs: 30_000,
    execFileImpl: async () => {
      diffCalls += 1;
      return { stdout: 'diff --git fake\n' };
    },
  });
  const [initialRef] = await adapter.discoverSubjects();

  clock.advance(31_000);
  mut.setPR({
    ...REGRESSION_PR_BASE,
    head: { ...REGRESSION_PR_BASE.head, sha: 'd3717f5b7ec06b1904ce4b86117783b1679b8d53' },
  });

  const refreshedState = await adapter.fetchState(initialRef);
  const content = await adapter.fetchContent(initialRef);

  assert.equal(refreshedState.ref.revisionRef, 'd3717f5b7ec06b1904ce4b86117783b1679b8d53');
  assert.equal(content.ref.revisionRef, 'd3717f5b7ec06b1904ce4b86117783b1679b8d53');
  assert.equal(mut.calls.get, 1,
    'fetchContent with the original ref should reuse the fresh snapshot from fetchState');
  assert.equal(diffCalls, 1);
});
