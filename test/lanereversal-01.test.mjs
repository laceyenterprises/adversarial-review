import './helpers/load-aware-timeout-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchPrimaryChange, checkPrimaryChange } from '../src/ama/primary-change.mjs';
import { isEligibleForAmaClosure } from '../src/ama/eligibility.mjs';
import { evaluateMergeEligibility } from '../src/ama/merge-eligibility.mjs';
import { readHeadAttestationChainForPr } from '../src/daemon-worker-identity.mjs';
import { readLaneReversalIdentity } from '../src/ama/lane-reversal.mjs';
import { buildRemediationPrompt } from '../src/remediation-prompt-builder.mjs';
import { collect as collectRebased, review as rebasedReview } from './helpers/hamclose-history.mjs';

const BASE = 'b'.repeat(40), PRIMARY = 'a'.repeat(40), HEAD = 'c'.repeat(40);
const REPO = 'fixture/repo', JOB = 'fixture__repo-pr-7-fix-all';
const primary = { filename: 'src/example.mjs', status: 'modified', additions: 2, deletions: 1,
  patch: '@@ -10 +10,2 @@\n-start()\n+unsafe_start()\n+log_start()' };
const repair = { ...primary, additions: 1, deletions: 2,
  patch: '@@ -10,2 +10 @@\n-unsafe_start()\n-log_start()\n+start()' };
const finding = '- **Unsafe startup**\n  - **File:** `src/example.mjs`\n  - **Lines:** `10-11`\n  - **Problem:** Unsafe startup.\n  - **Recommended fix:** Restore the shared startup.';
const body = `## Blocking issues\n${finding}\n## Non-blocking issues\n- None.\n## Verdict\nRequest changes`;

function fixture(t, { owner = true, mutateJob = () => {}, mutateCommit = () => {},
  mutateReview = () => {}, mutateAttestation = () => {}, cleanReview = true, hammer = false,
  bucket = 'completed', persistent = false, receiptLedger = 'shared', readError } = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'lane-reversal-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const job = { jobId: JOB, repo: REPO, prNumber: 7, revisionRef: PRIMARY, status: 'completed',
    closureHandoff: { reason: 'final-fix-all', headSha: PRIMARY, review: 'full' },
    remediationWorker: { workerClass: 'remediator-codex-corp', launchRequestId: 'lrq_fixture' } };
  mutateJob(job);
  const dir = join(rootDir, 'data', 'follow-up-jobs', bucket);
  mkdirSync(dir, { recursive: true });
  if (owner) writeFileSync(join(dir, `${JOB}.json`), JSON.stringify(job));
  const commit = { sha: HEAD, parents: [{ sha: PRIMARY }],
    // Names and emails intentionally offer no identity authority.
    author: null, committer: null,
    commit: { message: `Repair startup\n\nWorker-Class: ${hammer ? 'hammer' : 'codex-remediation'}\n${hammer ? 'Worker-Ticket: HAM' : `Worker-Job-Id: ${JOB}`}\nReviewed-Head: ${PRIMARY}\nReversal-Authorized-By: PRR_fixture finding=1 kind=blocking` },
    files: [repair] };
  if (hammer) { commit.author = { login: 'hammer-worker' }; commit.committer = { login: 'hammer-worker' }; }
  mutateCommit(commit);
  const review = { node_id: 'PRR_fixture', commit_id: PRIMARY, state: 'CHANGES_REQUESTED',
    user: { login: 'lacey-claude-reviewer[bot]' }, body };
  mutateReview(review);
  const reviews = [review, ...(cleanReview ? [{ ...review, node_id: 'PRR_clean', commit_id: HEAD,
    state: 'APPROVED', body: '## Blocking issues\n- None.\n## Non-blocking issues\n- None.\n## Verdict\nApproved' }] : [])];
  const attestation = { repo: REPO, pr_number: 7, kind: 'produced', valid: true, head_sha: HEAD,
    payload: { launch_request_id: 'lrq_fixture', worker_class: 'remediator-codex-corp' } };
  mutateAttestation(attestation);
  let identityReads = 0;
  const chainTargets = [];
  const runtimeDsn = 'postgresql://runtime.invalid/ledger';
  const canonicalDsn = 'postgresql://canonical.invalid/ledger';
  const env = { AGENT_OS_SESSION_LEDGER_DSN: runtimeDsn, AGENT_OS_SESSION_LEDGER_POSTGRES_RUNTIME: 'on' };
  if (receiptLedger !== 'shared') env.AGENT_OS_SESSION_LEDGER_CANONICAL_DSN = canonicalDsn;
  const receiptDsn = receiptLedger === 'canonical' ? canonicalDsn : runtimeDsn;
  const readLaneIdentityImpl = args => {
    identityReads++;
    return readLaneReversalIdentity({ ...args, env,
      readHeadAttestationChainForPrImpl: options => readHeadAttestationChainForPr({ ...options,
        execFileImpl: async (command, argv, { env: childEnv }) => {
          assert.equal(command, 'hq');
          assert.deepEqual(argv, ['attest', 'chain', '--repo', REPO, '--pr', '7', '--json']);
          const target = childEnv.AGENT_OS_SESSION_LEDGER_DSN;
          chainTargets.push(target);
          if (readError) throw readError;
          const rows = target === receiptDsn ? [attestation] : [];
          return { stdout: JSON.stringify(rows) };
        },
        retryDelaysMs: [], logger: { warn() {} },
      }) });
  };
  const get = async path => {
    if (path === `repos/${REPO}/pulls/7`) return { base: { sha: BASE }, head: { sha: HEAD } };
    if (path.includes('/reviews?')) return reviews;
    if (path.includes('/comments?')) return [];
    if (path === `repos/${REPO}/commits/${HEAD}`) return structuredClone(commit);
    if (path.includes('/compare/')) {
      const [from, to] = path.split('/compare/')[1].split('...');
      const order = [BASE, PRIMARY, HEAD];
      return { status: from === to ? 'identical' : order.indexOf(from) < order.indexOf(to) ? 'ahead' : 'behind',
        merge_base_commit: { sha: BASE },
        files: to === PRIMARY ? [primary] : [],
        total_commits: from === BASE && to === HEAD ? 2 : 0,
        commits: from === BASE && to === HEAD ? [{ sha: PRIMARY, commit: { message: 'Primary change' } }, commit] : [] };
    }
    throw new Error(`Unexpected synthetic read ${path}`);
  };
  if (persistent) Object.assign(get, { persistPrimaryChange: true, metadata: get });
  const collect = () => fetchPrimaryChange({ repo: REPO, prNumber: 7, headSha: HEAD,
    rootDir, get, readLaneIdentityImpl }, {
    fetchCiCostImpl: async () => ({ ok: true, headSha: HEAD }),
  });
  return { collect, get, readLaneIdentityImpl, job, rootDir, attestation, chainTargets, env, ownerPath: join(dir, `${JOB}.json`),
    identityReads: () => identityReads };
}

test('LAC-2235 reads the exact produced row from the configured canonical ledger', async t => {
  const f = fixture(t, { receiptLedger: 'canonical', bucket: 'stopped', persistent: true });
  assertGates(await f.collect(), true);
  assert.deepEqual(f.chainTargets, [f.env.AGENT_OS_SESSION_LEDGER_CANONICAL_DSN]);
  assert.equal(f.env.AGENT_OS_SESSION_LEDGER_DSN, 'postgresql://runtime.invalid/ledger');
});

test('LAC-2235 an empty canonical chain cannot fall back to a runtime receipt', async t => {
  const f = fixture(t, { receiptLedger: 'runtime' });
  assertGates(await f.collect(), false);
  assert.deepEqual(f.chainTargets, [f.env.AGENT_OS_SESSION_LEDGER_CANONICAL_DSN]);
  assert.match((await f.collect()).rejectedReversalAuthorizations[0].detail,
    /missing-produced-head-attestation; transient=false; ledgerTarget=canonical-postgres/);
});

for (const [name, selectors, canonical] of [
  ['legacy gate on', { AGENT_OS_SESSION_LEDGER_POSTGRES_RUNTIME: ' ON ' }, true],
  ['legacy gate off', { AGENT_OS_SESSION_LEDGER_POSTGRES_RUNTIME: 'off' }, false],
  ['SQLite backend', { AGENT_OS_SESSION_LEDGER_BACKEND: 'sqlite' }, false],
  ['Postgres backend', { AGENT_OS_SESSION_LEDGER_BACKEND: 'postgres' }, true],
  ['legacy off overrides Postgres backend', { AGENT_OS_SESSION_LEDGER_POSTGRES_RUNTIME: 'off',
    AGENT_OS_SESSION_LEDGER_BACKEND: 'postgres' }, false],
  ['legacy on overrides SQLite backend', { AGENT_OS_SESSION_LEDGER_POSTGRES_RUNTIME: 'on',
    AGENT_OS_SESSION_LEDGER_BACKEND: 'sqlite' }, true],
  ['unspecified backend', {}, false],
  ['blank canonical DSN', { AGENT_OS_SESSION_LEDGER_POSTGRES_RUNTIME: 'on',
    AGENT_OS_SESSION_LEDGER_CANONICAL_DSN: '  ' }, false],
]) test(`canonical routing preserves the full child environment: ${name}`, async () => {
  const env = {
    AGENT_OS_SESSION_LEDGER_DSN: 'postgresql://runtime.invalid/ledger',
    AGENT_OS_SESSION_LEDGER_CANONICAL_DSN: ' postgresql://canonical.invalid/ledger ',
    AGENT_OS_SESSION_LEDGER_DSN_DIRECT: 'postgresql://direct.invalid/ledger',
    AGENT_OS_SESSION_LEDGER_VDB: 'true',
    AGENT_OS_SESSION_LEDGER_VDB_DIRECT_DSN: 'postgresql://vdb.invalid/ledger',
    AGENT_OS_SESSION_LEDGER_DB_PATH: '/synthetic/sqlite.db',
    UNRELATED: 'preserved',
    ...selectors,
  };
  const original = { ...env };
  const expected = canonical ? { ...env, AGENT_OS_SESSION_LEDGER_DSN: env.AGENT_OS_SESSION_LEDGER_CANONICAL_DSN.trim() } : env;
  if (canonical) for (const key of ['AGENT_OS_SESSION_LEDGER_DSN_DIRECT', 'AGENT_OS_SESSION_LEDGER_VDB',
    'AGENT_OS_SESSION_LEDGER_VDB_DIRECT_DSN', 'AGENT_OS_SESSION_LEDGER_DB_PATH']) delete expected[key];
  const childEnvironments = [];
  const result = await readLaneReversalIdentity({ repo: REPO, prNumber: 7, currentHeadSha: HEAD, env,
    readHeadAttestationChainForPrImpl: options => readHeadAttestationChainForPr({ ...options,
      execFileImpl: async (_command, _argv, { env: childEnv }) => {
        childEnvironments.push({ ...childEnv });
        return { stdout: '[]' };
      },
    }),
  });
  assert.deepEqual(childEnvironments, [expected]);
  assert.deepEqual(result, { ok: false, reason: 'missing-produced-head-attestation',
    ledgerTarget: canonical ? 'canonical-postgres' : 'runtime' });
  assert.deepEqual(env, original);
});

for (const message of ['could not connect to server: Connection refused',
  'server closed the connection unexpectedly', 'connection to server at "fixture" failed: Connection timed out',
  'the database system is starting up']) {
  test(`Postgres failure retries within the chain budget and remains diagnosable: ${message}`, async t => {
    let calls = 0;
    const delays = [];
    const result = await readLaneReversalIdentity({ repo: REPO, prNumber: 7, currentHeadSha: HEAD,
      env: { AGENT_OS_SESSION_LEDGER_BACKEND: 'postgres', AGENT_OS_SESSION_LEDGER_CANONICAL_DSN: 'postgresql://canonical.invalid/ledger' },
      readHeadAttestationChainForPrImpl: options => readHeadAttestationChainForPr({ ...options,
        retryDelaysMs: [1, 2], sleepImpl: async ms => delays.push(ms), logger: { warn() {} },
        execFileImpl: async () => {
          calls++;
          throw Object.assign(new Error('hq attest failed'), { stderr: message });
        },
      }),
    });
    assert.equal(calls, 3);
    assert.deepEqual(delays, [1, 2]);
    assert.equal(result.reason, 'head-attestation-chain-read-failed');
    assert.equal(result.transient, true);
    assert.equal(result.ledgerTarget, 'canonical-postgres');
    const f = fixture(t, { receiptLedger: 'canonical',
      readError: Object.assign(new Error('hq attest failed'), { stderr: message }) });
    const evidence = await f.collect();
    assertGates(evidence, false);
    assert.match(evidence.rejectedReversalAuthorizations[0].detail,
      /head-attestation-chain-read-failed; transient=true; ledgerTarget=canonical-postgres/);
  });
}

test('permanent canonical read failures remain non-transient and fail closed', async t => {
  const f = fixture(t, { receiptLedger: 'canonical', readError: new Error('password authentication failed') });
  const evidence = await f.collect();
  assertGates(evidence, false);
  assert.match(evidence.rejectedReversalAuthorizations[0].detail,
    /head-attestation-chain-read-failed; transient=false; ledgerTarget=canonical-postgres/);
});

test('a mismatched produced subject is distinct from an absent receipt', async t => {
  const f = fixture(t, { mutateAttestation: row => { row.repo = 'foreign/repo'; } });
  const evidence = await f.collect();
  assertGates(evidence, false);
  assert.match(evidence.rejectedReversalAuthorizations[0].detail,
    /produced-attestation-subject-mismatch; transient=false; ledgerTarget=runtime/);
});

function closer(primaryChange, strictNonBlockingRemediation = true) {
  const head = primaryChange.headSha;
  return isEligibleForAmaClosure({ headSha: head, verdict: 'approved', riskClass: 'low',
    remediationPending: false, blockingFindingState: 'known', blockingFindingCount: 0,
    nonBlockingFindingState: 'known', nonBlockingFindingCount: 0 },
  { headSha: head, isOpen: true, mergeableState: 'MERGEABLE', labels: [],
    statusCheckRollup: [{ name: 'unit', conclusion: 'SUCCESS' }] },
  { enabled: true, strictNonBlockingRemediation, eligibility: { riskClasses: ['low'] },
    branchProtection: { required: false } }, { primaryChange });
}
function daemon(primaryChange, strictNonBlockingRemediation = true) {
  return evaluateMergeEligibility({ primaryChange, strictNonBlockingRemediation,
    verdict: 'settled-success', requiredChecks: true, mergeable: true,
    candidateHead: primaryChange.headSha, validatedHead: primaryChange.headSha, leaseHeld: true, labels: [],
    branchProtectionRequired: false });
}
function assertGates(evidence, eligible, strict = true) {
  const preservation = checkPrimaryChange(evidence, evidence.headSha, { strictNonBlockingRemediation: strict });
  assert.equal(preservation.ok, eligible, JSON.stringify(preservation));
  if (!eligible) assert.equal(preservation.reason, 'primary-change-reverted');
  for (const result of [closer(evidence, strict), daemon(evidence, strict)]) {
    assert.equal(result.eligible, eligible, JSON.stringify(result));
    if (!eligible) assert.ok(result.reasons.includes('primary-change-reverted'), JSON.stringify(result));
  }
}

test('PRIMARYLANEPROV-01: a closer reversal uses the review of the lane head and covers all inserted content', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'reviewed-lane-head-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const laneHead = 'd'.repeat(40);
  const file = 'src/preview.mjs';
  const insertion = { filename: file, status: 'modified', additions: 4, deletions: 0,
    patch: '@@ -9,0 +10,4 @@\n+\n+enablePreview();\n+recordPreview();\n+ \t' };
  const laneFile = { filename: 'src/lane.mjs', status: 'added', additions: 1, deletions: 0,
    patch: '@@ -0,0 +1 @@\n+export const ready = true;' };
  const builder = { sha: PRIMARY, parents: [{ sha: BASE }], commit: { message: 'Add preview' } };
  const lane = { sha: laneHead, parents: [{ sha: PRIMARY }],
    commit: { message: `Prepare preview\n\nWorker-Class: codex-remediation\nWorker-Job-Id: ${JOB}\nReviewed-Head: ${PRIMARY}\nReversal-Authorized-By: PRR_older finding=1 kind=non-blocking` } };
  for (const [name, { path = file, lines = '11-12', login = 'lacey-claude-reviewer[bot]',
    reviewedHead = laneHead, cite = true, eligible = false, reason }] of Object.entries({
    'adjacent blanks are outside the cited content': { eligible: true },
    'adjacent nonblank content is outside the citation': { lines: '11', reason: 'not-covered-by-cited-finding' },
    'the cited path differs': { path: 'src/other.mjs', reason: 'not-covered-by-cited-finding' },
    'the closer has no citation': { cite: false },
    'the reviewer is unknown': { login: 'untrusted-reviewer[bot]', reason: 'review-not-current' },
    'the review head is outside the closer ancestry': { reviewedHead: 'e'.repeat(40), reason: 'review-not-current' },
  })) await t.test(name, async () => {
    const ham = { sha: HEAD, parents: [{ sha: laneHead }],
      author: { login: 'the-hammer-lacey[bot]' }, committer: { login: 'the-hammer-lacey[bot]' },
      commit: { message: ['Remove unused preview', '', 'Worker-Class: hammer', 'Worker-Ticket: HAM',
        `Reviewed-Head: ${reviewedHead}`, ...(cite ? ['Reversal-Authorized-By: PRR_preview finding=1 kind=non-blocking'] : [])].join('\n') },
      files: [{ ...insertion, additions: 0, deletions: 4,
        patch: '@@ -10,4 +9,0 @@\n-\n-enablePreview();\n-recordPreview();\n- \t' }] };
    const review = { node_id: 'PRR_preview', commit_id: reviewedHead, state: 'COMMENTED', user: { login },
      body: `## Non-blocking issues\n- **Unused preview**\n  - **File:** \`${path}\`\n  - **Lines:** \`${lines}\`\n  - **Problem:** Preview is unreachable.\n  - **Recommended fix:** Remove preview calls.\n\n## Verdict\nComment only` };
    const get = async endpoint => {
      if (endpoint.endsWith('/pulls/7')) return { base: { sha: BASE }, head: { sha: HEAD } };
      if (endpoint.includes('/reviews?')) return [review];
      if (endpoint.endsWith(`/commits/${laneHead}`)) return lane;
      if (endpoint.endsWith(`/commits/${HEAD}`)) return ham;
      const [from, to] = endpoint.split('/compare/')[1].split('...');
      return { status: from === to ? 'identical' : from === reviewedHead && from !== laneHead ? 'behind' : 'ahead',
        merge_base_commit: { sha: BASE },
        files: to === PRIMARY ? [insertion] : to === laneHead ? [insertion, laneFile] : [laneFile],
        ...(from === BASE && to === HEAD ? { total_commits: 3, commits: [builder, lane, ham] } : {}) };
    };
    const identityReads = [];
    const evidence = await fetchPrimaryChange({ repo: REPO, prNumber: 7, headSha: HEAD, rootDir, get,
      readLaneIdentityImpl: ({ currentHeadSha }) => { identityReads.push(currentHeadSha); return null; } },
    { fetchCiCostImpl: async () => ({ ok: true, headSha: HEAD }) });
    assert.deepEqual(identityReads, []);
    assert.equal(evidence.primaryHead, PRIMARY);
    assert.deepEqual(evidence.rejectedReversalAuthorizations[0], {
      commit: laneHead, review: 'PRR_older', finding: 1, kind: 'non-blocking', reason: 'lane-commit-provenance',
    });
    assertGates(evidence, eligible);
    if (reason) {
      const reversal = checkPrimaryChange(evidence, HEAD, { strictNonBlockingRemediation: true });
      assert.ok(reversal.missingEvidence.rejected.some(entry => entry.commit === HEAD && entry.reason === reason));
    }
  });
});

for (const bucket of ['in-progress', 'completed', 'stopped-archived/fixture-date']) {
  test(`attested fix-all owner in ${bucket} authorizes a cited reversal at both gates after clean re-review`, async t => {
    const f = fixture(t, { bucket });
    const archive = join(f.rootDir, 'data', 'follow-up-jobs', 'stopped-archived');
    mkdirSync(archive, { recursive: true });
    writeFileSync(join(archive, 'unrelated.txt'), 'Not an archive directory.');
    const evidence = await f.collect();
    assert.equal(evidence.primaryHead, PRIMARY);
    assert.equal(evidence.reversalAuthorizations.length, 1);
    assertGates(evidence, true);
    assert.equal(f.identityReads(), 1);
  });
}

for (const unreadable of ['empty', 'partial', 'read-error']) {
  test(`lane ownership skips ${unreadable} queue records without granting authority`, async t => {
    const f = fixture(t);
    const path = join(f.rootDir, 'data', 'follow-up-jobs', 'completed', `${JOB}-unreadable.json`);
    if (unreadable === 'read-error') mkdirSync(path);
    else writeFileSync(path, unreadable === 'empty' ? '' : '{"jobId":');
    assertGates(await f.collect(), true);
    rmSync(f.ownerPath);
    assertGates(await f.collect(), false);
  });
}

for (const [name, options] of [
  ['missing owner', { owner: false }],
  ['wrong PR', { mutateJob: j => { j.prNumber = 8; } }],
  ['wrong attested PR', { mutateAttestation: a => { a.pr_number = 8; } }],
  ['wrong attested repository', { mutateAttestation: a => { a.repo = 'other/repo'; } }],
  ['wrong input head', { mutateJob: j => { j.closureHandoff.headSha = BASE; } }],
  ['other handoff', { mutateJob: j => { j.closureHandoff.reason = 'conflict-primary-unproven'; } }],
  ['wrong launch', { mutateAttestation: a => { a.payload.launch_request_id = 'lrq_other'; } }],
  ['wrong class', { mutateAttestation: a => { a.payload.worker_class = 'remediator-claude'; } }],
  ['non-builder owner class', {
    mutateJob: j => { j.remediationWorker.workerClass = 'hammer'; },
    mutateAttestation: a => { a.payload.worker_class = 'hammer'; },
  }],
  ['invalid attestation', { mutateAttestation: a => { a.valid = false; } }],
  ['wrong attested SHA', { mutateAttestation: a => { a.head_sha = PRIMARY; } }],
  ['reviewed attestation only', { mutateAttestation: a => { a.kind = 'reviewed'; } }],
  ['wrong reviewed head', { mutateCommit: c => { c.commit.message = c.commit.message.replace(`Reviewed-Head: ${PRIMARY}`, `Reviewed-Head: ${BASE}`); } }],
  ['review absent from the PR', { mutateReview: r => { r.node_id = 'PRR_other'; } }],
  ['uncited reversal', { mutateCommit: c => { c.commit.message = c.commit.message.replace(/\nReversal-Authorized-By:.*/, ''); } }],
  ['missing explicit kind', { mutateCommit: c => { c.commit.message = c.commit.message.replace(' kind=blocking', ''); } }],
  ['wrong job', { mutateCommit: c => { c.commit.message = c.commit.message.replace(JOB, 'other-job'); } }],
  ['conflicting job claims', { mutateCommit: c => { c.commit.message += '\nWorker-Job-Id: other-job'; } }],
  ['wrong trailer class', { mutateCommit: c => { c.commit.message = c.commit.message.replace('Worker-Class: codex-remediation', 'Worker-Class: codex'); } }],
  ['missing trailer class', { mutateCommit: c => { c.commit.message = c.commit.message.replace('Worker-Class: codex-remediation\n', ''); } }],
  ['conflicting trailer classes', { mutateCommit: c => { c.commit.message += '\nWorker-Class: codex'; } }],
  ['uncited region', { mutateReview: r => { r.body = r.body.replace('10-11', '30-31'); } }],
  ['missing finding', { mutateCommit: c => { c.commit.message = c.commit.message.replace('finding=1', 'finding=2'); } }],
  ['non-admissible finding', { mutateReview: r => { r.body = `## Blocking issues\n- None.\n## Non-blocking issues\n${finding}\n## Verdict\nComment only`; } }],
  ['untrusted reviewer', { mutateReview: r => { r.user.login = 'fixture-builder'; } }],
]) test(`${name} refuses at closer and daemon even after a clean review`, async t => {
  assertGates(await fixture(t, options).collect(), false);
});

test('strict non-blocking finding admission remains shared', async t => {
  const f = fixture(t, {
    mutateCommit: c => { c.commit.message = c.commit.message.replace('kind=blocking', 'kind=non-blocking'); },
    mutateReview: r => { r.body = `## Blocking issues\n- None.\n## Non-blocking issues\n${finding}\n## Verdict\nComment only`; },
  });
  const evidence = await f.collect();
  assertGates(evidence, true);
  assertGates(evidence, false, false);
});

test('hammer still authorizes without lane ownership or produced lane attestation', async t => {
  const f = fixture(t, { owner: false, hammer: true, mutateAttestation: a => { a.valid = false; } });
  assertGates(await f.collect(), true);
  assert.equal(f.identityReads(), 0);
});

test('persistent history never reuses lane authority after owner or attestation changes', async t => {
  const f = fixture(t, { persistent: true });
  assertGates(await f.collect(), true);
  f.attestation.valid = false;
  assertGates(await f.collect(), false);
  f.attestation.valid = true;
  assertGates(await f.collect(), true);
  rmSync(f.ownerPath);
  assertGates(await f.collect(), false);
});

for (const cited of [true, false]) test(`a later hammer cannot redefine the primary boundary around an earlier ${cited ? 'cited' : 'uncited'} lane reversal`, async t => {
  const f = fixture(t, { mutateCommit: c => {
    if (!cited) c.commit.message = c.commit.message.replace(/\nReversal-Authorized-By:.*/, '');
  } });
  const next = 'd'.repeat(40);
  const get = async path => {
    if (path === `repos/${REPO}/pulls/7`) return { base: { sha: BASE }, head: { sha: next } };
    if (path.includes('/compare/')) {
      const [from, to] = path.split('/compare/')[1].split('...');
      if (from === next) return { status: 'behind' };
      if (to === next) {
        const value = await f.get(path.replaceAll(next, HEAD));
        return from === BASE ? { ...value, total_commits: 3, commits: [...value.commits,
          { sha: next, parents: [{ sha: HEAD }], commit: { message: 'Later repair\n\nWorker-Class: hammer\nWorker-Ticket: HAM' },
            author: { login: 'hammer-worker' }, committer: { login: 'hammer-worker' }, files: [] }] } : value;
      }
    }
    return f.get(path);
  };
  const evidence = await fetchPrimaryChange({ repo: REPO, prNumber: 7, headSha: next,
    rootDir: f.rootDir, get, readLaneIdentityImpl: f.readLaneIdentityImpl },
  { fetchCiCostImpl: async () => ({ ok: true, headSha: next }) });
  assert.equal(evidence.primaryHead, PRIMARY);
  assertGates(evidence, cited);
});

for (const [superseded, replacementContext, failedOriginalRead] of [[false, false], [true, false], [false, true], [true, false, true]]) test(`rebased lane reversal ${superseded ? 'pinned by immutable later review' : 'with current citation'} retains patch proof${replacementContext ? ' beside unchanged replacement context' : ''}${failedOriginalRead ? ' and original read diagnostics' : ''}`, async t => {
  const source = await collectRebased({
    ...(superseded ? { originalRecorded: true, reviews: [rebasedReview(), rebasedReview({
      node_id: 'PRR_clean', commit_id: 'f'.repeat(40), state: 'APPROVED',
      body: '## Blocking issues\n- None.\n## Non-blocking issues\n- None.\n## Verdict\nApproved',
    })] } : {}),
  });
  const f = fixture(t, { mutateJob: j => {
    j.prNumber = 8088; j.revisionRef = '1'.repeat(40); j.closureHandoff.headSha = j.revisionRef;
  } });
  const jobDir = join(f.rootDir, 'data', 'follow-up-jobs', 'completed');
  const rebasedJob = { ...f.job, jobId: 'fixture__repo-pr-8088-fix-all' };
  writeFileSync(join(jobDir, `${rebasedJob.jobId}.json`), JSON.stringify(rebasedJob));
  const get = async path => {
    const value = structuredClone(await source.transport(path));
    const change = commit => {
      if (!commit?.commit?.message?.includes('Worker-Class: hammer')) return;
      commit.commit.message = commit.commit.message.replace('Worker-Class: hammer', 'Worker-Class: codex-remediation')
        .replace('Worker-Ticket: HAM', `Worker-Job-Id: ${rebasedJob.jobId}`);
      commit.author = null; commit.committer = null;
    };
    change(value);
    for (const commit of value.commits || []) change(commit);
    if (replacementContext) {
      if (Array.isArray(value)) {
        for (const entry of value) {
          if (entry.body) entry.body = entry.body.replace('`10-11`', '`10-12`');
        }
      }
      for (const file of value.files || []) {
        if (!file.patch?.includes('\n-start()\n+start_unsafe()')) continue;
        file.patch = file.patch.replace(/@@ -(\d+) \+(\d+),2 @@/, '@@ -$1,2 +$2,3 @@')
          .replace('\n-start()', '\n-start()\n-keep()') + '\n+keep()';
        file.additions++;
        file.deletions++;
      }
      if (path.endsWith(`${'b'.repeat(40)}...${HEAD}`)) value.files = [{
        filename: 'src/a.mjs', status: 'modified', additions: 1, deletions: 1,
        patch: '@@ -15,3 +15,3 @@\n start()\n keep()\n-old_other()\n+new_other()',
      }];
    }
    return value;
  };
  const evidence = await fetchPrimaryChange({ rootDir: f.rootDir, repo: REPO, prNumber: 8088,
    headSha: HEAD, get, readLaneIdentityImpl: async ({ currentHeadSha }) =>
      failedOriginalRead && currentHeadSha !== HEAD
        ? { ok: false, reason: 'head-attestation-chain-read-failed', transient: true, ledgerTarget: 'canonical-postgres' }
        : { ok: true, resolvedBy: 'head-attestation', rowHeadSha: currentHeadSha,
          launchRequestId: 'lrq_fixture', workerClass: 'remediator-codex-corp' },
  }, { fetchCiCostImpl: async () => ({ ok: true, headSha: HEAD }) });
  if (failedOriginalRead) {
    assertGates(evidence, false);
    assert.ok(evidence.rejectedReversalAuthorizations.some(entry =>
      entry.detail?.includes('commit-provenance: head-attestation-chain-read-failed; transient=true; ledgerTarget=canonical-postgres')));
    return;
  }
  assertGates(evidence, true);
  const bad = structuredClone(evidence);
  bad.reversalAuthorizations[0].commit.files[0].patch =
    bad.reversalAuthorizations[0].commit.files[0].patch.replace(
      replacementContext ? '+start()' : '-start_unsafe()', replacementContext ? '+other_start()' : '-other_start()');
  assertGates(bad, false);
  if (replacementContext) {
    for (const mutate of [
      value => { value.reversalAuthorizations[0].laneIdentity.ok = false; },
      value => { value.finalFiles[0].patch = value.finalFiles[0].patch.replace(' keep()', ' other_keep()'); },
      value => { value.finalFiles[0].patch = value.finalFiles[0].patch.replace('@@ -15,3 +15,3 @@', '@@ -16,3 +16,3 @@'); },
    ]) {
      const bad = structuredClone(evidence);
      mutate(bad);
      assertGates(bad, false);
    }
  }
});

test('fix-all worker prompt requires conditional worker-generated citations only in fix-all mode', t => {
  const f = fixture(t);
  const job = { ...f.job, branch: 'fixture-branch', baseBranch: 'main', builderTag: 'codex', reviewBody: body };
  const options = { template: 'Synthetic template.', remediationReplyPath: join(f.rootDir, 'reply.json') };
  const prompt = buildRemediationPrompt(job, options);
  assert.match(prompt, /When, and only when, your fix removes or replaces/);
  assert.match(prompt, /Reversal-Authorized-By: <review node ID or URL>/);
  assert.match(prompt, /never an operator-authored waiver/);
  assert.match(prompt, /hq branch-push complete --reason 'final-fix-all review-cited remediation'/);
  assert.match(prompt, /missing\/failed attestation is an operational blocker/);
  assert.doesNotMatch(buildRemediationPrompt({ ...job, closureHandoff: undefined }, options),
    /Reversal-Authorized-By: <review node ID or URL>/);
});
