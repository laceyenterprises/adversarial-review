import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildDuplicateFamilyPacket, writeDuplicateFamilyPacket } from '../src/duplicate-family-packet.mjs';
import { ensureReviewStateSchema, openReviewStateDb } from '../src/review-state.mjs';

const REPO = 'laceyenterprises/agent-os';
const FAMILY_ID = 'agent-os-main-dpa-03-2026-09-11-abcdef1234';

function sh(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function execFileViaSync(command, args, options) {
  try {
    return {
      stdout: execFileSync(command, args, {
        encoding: 'utf8',
        maxBuffer: options?.maxBuffer,
        timeout: options?.timeout,
      }),
      stderr: '',
    };
  } catch (err) {
    if (Buffer.isBuffer(err.stdout)) err.stdout = err.stdout.toString('utf8');
    if (Buffer.isBuffer(err.stderr)) err.stderr = err.stderr.toString('utf8');
    throw err;
  }
}

function write(cwd, rel, body) {
  writeFileSync(path.join(cwd, rel), body, 'utf8');
}

function commit(cwd, message) {
  sh(cwd, ['add', '.']);
  sh(cwd, ['commit', '-m', message]);
  return sh(cwd, ['rev-parse', 'HEAD']);
}

function makeFixtureRepo() {
  const repoDir = mkdtempSync(path.join(tmpdir(), 'duplicate-family-packet-repo-'));
  sh(repoDir, ['init', '-b', 'main']);
  sh(repoDir, ['config', 'user.email', 'fixture@example.test']);
  sh(repoDir, ['config', 'user.name', 'Fixture User']);
  write(repoDir, 'shared.txt', 'base\n');
  const baseSha = commit(repoDir, 'base');

  sh(repoDir, ['checkout', '-b', 'codex/dpa-03']);
  write(repoDir, 'shared.txt', 'base\ncodex packet\n');
  write(repoDir, 'packet.txt', 'codex packet\n');
  const codexHead = commit(repoDir, 'codex packet');

  sh(repoDir, ['checkout', 'main']);
  sh(repoDir, ['checkout', '-b', 'claude/dpa-03']);
  write(repoDir, 'shared.txt', 'base\nclaude packet\n');
  write(repoDir, 'evidence.txt', 'claude evidence\n');
  const claudeHead = commit(repoDir, 'claude packet');

  sh(repoDir, ['checkout', 'main']);
  write(repoDir, 'main-only.txt', 'current main moved\n');
  const currentMain = commit(repoDir, 'advance main');
  return { repoDir, baseSha, codexHead, claudeHead, currentMain };
}

function insertFamily(rootDir, fixture, { missingHead = null } = {}) {
  const db = openReviewStateDb(rootDir);
  ensureReviewStateSchema(db);
  const now = '2026-09-11T12:00:00.000Z';
  db.prepare(
    `INSERT INTO duplicate_families (
       family_id, family_key, target_repo, base_branch, normalized_work_identity,
       status, strongest_signal, transition_log_json, candidate_count,
       first_detected_at, last_seen_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    FAMILY_ID,
    `${REPO}|main|dpa-03`,
    REPO,
    'main',
    'dpa-03',
    'advisory',
    'dispatch-ticket',
    JSON.stringify([{ at: now, transition: 'detected-advisory', status: 'advisory' }]),
    2,
    now,
    now,
    now,
  );
  const insertCandidate = db.prepare(
    `INSERT INTO duplicate_family_candidates (
       family_id, repo, pr_number, title, pr_state, base_branch, head_branch,
       head_sha, base_sha, role, work_identity_json, signals_json,
       suppressions_json, labels_json, first_seen_at, last_seen_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  insertCandidate.run(
    FAMILY_ID,
    REPO,
    6466,
    '[codex] DPA-03 packet',
    'open',
    'main',
    'codex/dpa-03',
    missingHead === 6466 ? '0'.repeat(40) : fixture.codexHead,
    fixture.baseSha,
    'candidate',
    JSON.stringify({ normalizedWorkIdentity: 'dpa-03' }),
    JSON.stringify([{ kind: 'dispatch-ticket', value: 'DPA-03', strength: 'strong' }]),
    JSON.stringify([]),
    JSON.stringify(['duplicate-family']),
    now,
    now,
    now,
  );
  insertCandidate.run(
    FAMILY_ID,
    REPO,
    6463,
    '[claude-code] DPA-03 packet',
    'open',
    'main',
    'claude/dpa-03',
    missingHead === 6463 ? '0'.repeat(40) : fixture.claudeHead,
    fixture.baseSha,
    'candidate',
    JSON.stringify({ normalizedWorkIdentity: 'dpa-03' }),
    JSON.stringify([{ kind: 'dispatch-ticket', value: 'DPA-03', strength: 'strong' }]),
    JSON.stringify([]),
    JSON.stringify(['duplicate-family']),
    now,
    now,
    now,
  );
  db.close();
}

function makeRootWithFamily(fixture, options = {}) {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'duplicate-family-packet-root-'));
  insertFamily(rootDir, fixture, options);
  return rootDir;
}

async function buildFixturePacket(rootDir, repoDir) {
  return buildDuplicateFamilyPacket({
    rootDir,
    repoDir,
    familyId: FAMILY_ID,
    skipGithub: true,
  });
}

async function buildFixturePacketWithOptions(rootDir, repoDir, options = {}) {
  return buildDuplicateFamilyPacket({
    rootDir,
    repoDir,
    familyId: FAMILY_ID,
    ...options,
  });
}

test('duplicate-family packet writes deterministic evidence files for divergent PR refs', async () => {
  const fixture = makeFixtureRepo();
  const rootDir = makeRootWithFamily(fixture);
  const outDir = path.join(rootDir, 'packet');
  const packet = await buildFixturePacket(rootDir, fixture.repoDir);
  const written = writeDuplicateFamilyPacket(packet, outDir).map((file) => path.basename(file));

  assert.deepEqual(written, [
    'candidate-6463.diffstat.txt',
    'candidate-6463.stale-base-diagnostic.txt',
    'candidate-6466.diffstat.txt',
    'candidate-6466.stale-base-diagnostic.txt',
    'comments.md',
    'family.json',
    'range-diff.txt',
    'report-skeleton.md',
    'reviews.md',
  ]);
  assert.match(readFileSync(path.join(outDir, 'candidate-6466.diffstat.txt'), 'utf8'), /packet\.txt/);
  assert.match(readFileSync(path.join(outDir, 'range-diff.txt'), 'utf8'), /# PR #6463 .* vs PR #6466 /);
  assert.match(readFileSync(path.join(outDir, 'reviews.md'), 'utf8'), /Check Rollup/);

  const before = Object.fromEntries(readdirSync(outDir).map((name) => [name, readFileSync(path.join(outDir, name), 'utf8')]));
  const packetAgain = await buildFixturePacket(rootDir, fixture.repoDir);
  writeDuplicateFamilyPacket(packetAgain, outDir);
  const after = Object.fromEntries(readdirSync(outDir).map((name) => [name, readFileSync(path.join(outDir, name), 'utf8')]));
  assert.deepEqual(after, before);
});

test('deleted loser branch renders from persisted candidate head SHA', async () => {
  const fixture = makeFixtureRepo();
  const rootDir = makeRootWithFamily(fixture);
  sh(fixture.repoDir, ['branch', '-D', 'claude/dpa-03']);

  const packet = await buildFixturePacket(rootDir, fixture.repoDir);
  assert.equal(packet.packet.candidates.find((candidate) => candidate.prNumber === 6463).headSha, fixture.claudeHead);
  assert.match(packet.files['candidate-6463.diffstat.txt'], /evidence\.txt/);
});

test('packet builder reads an injected query-only review database without schema writes', async () => {
  const fixture = makeFixtureRepo();
  const rootDir = makeRootWithFamily(fixture);
  const db = openReviewStateDb(rootDir);
  db.exec('DROP TABLE IF EXISTS reviewer_passes');
  db.pragma('query_only = ON');

  try {
    const packet = await buildFixturePacketWithOptions(rootDir, fixture.repoDir, {
      db,
      skipGithub: true,
    });
    assert.equal(packet.packet.family.familyId, FAMILY_ID);
    assert.deepEqual(packet.packet.reviewStateEvidence['6466'].passes, []);
  } finally {
    db.pragma('query_only = OFF');
    db.close();
  }
});

test('missing persisted loser object fetches PR head before typed failure', async () => {
  const fixture = makeFixtureRepo();
  const rootDir = makeRootWithFamily(fixture, { missingHead: 6463 });
  const calls = [];
  await assert.rejects(
    () => buildFixturePacketWithOptions(rootDir, fixture.repoDir, {
      execFileImpl: async (command, args, options) => {
        calls.push(args);
        return execFileViaSync(command, args, options);
      },
    }),
    (err) => {
      assert.equal(err.code, 'missing-object');
      assert.equal(err.details.reason, 'missing-persisted-head-object');
      assert.equal(err.details.prNumber, 6463);
      return true;
    }
  );
  assert.ok(
    calls.some((args) => args.join('\0') === [
      '-C',
      fixture.repoDir,
      'fetch',
      '--no-tags',
      'origin',
      'pull/6463/head',
    ].join('\0'))
  );
});

test('git helper retries transient failures before building packet', async () => {
  const fixture = makeFixtureRepo();
  const rootDir = makeRootWithFamily(fixture);
  let transientFailures = 0;

  const packet = await buildFixturePacketWithOptions(rootDir, fixture.repoDir, {
    execFileImpl: async (command, args, options) => {
      if (transientFailures === 0 && args.includes('cat-file')) {
        transientFailures += 1;
        const err = new Error('fatal: unable to create .git/index.lock: File exists');
        err.stderr = 'fatal: unable to create .git/index.lock: File exists';
        err.code = 'EAGAIN';
        throw err;
      }
      return execFileViaSync(command, args, options);
    },
  });

  assert.equal(transientFailures, 1);
  assert.equal(packet.packet.family.familyId, FAMILY_ID);
});

test('current-tree diff is labeled as stale-base diagnostic when current main moved', async () => {
  const fixture = makeFixtureRepo();
  const rootDir = makeRootWithFamily(fixture);
  const packet = await buildFixturePacket(rootDir, fixture.repoDir);
  const diagnostic = packet.files['candidate-6466.stale-base-diagnostic.txt'];

  assert.match(diagnostic, /STALE-BASE DIAGNOSTIC/);
  assert.match(diagnostic, /current base branch/);
  assert.match(diagnostic, /main-only\.txt/);
});

test('missing persisted base object is still labeled as stale against current base', async () => {
  const fixture = makeFixtureRepo();
  const rootDir = makeRootWithFamily(fixture);
  const missingBaseSha = '1'.repeat(40);
  const db = openReviewStateDb(rootDir);
  db.prepare('UPDATE duplicate_family_candidates SET base_sha = ? WHERE pr_number = ?')
    .run(missingBaseSha, 6466);
  db.close();

  const packet = await buildFixturePacket(rootDir, fixture.repoDir);
  const candidate = packet.packet.candidates.find((item) => item.prNumber === 6466);
  const diagnostic = packet.files['candidate-6466.stale-base-diagnostic.txt'];

  assert.equal(candidate.git.persistedBaseObjectAvailable, false);
  assert.equal(candidate.git.staleBaseDiagnostic.staleBase, true);
  assert.equal(candidate.git.staleBaseDiagnostic.persistedBaseSha, missingBaseSha);
  assert.match(diagnostic, /STALE-BASE DIAGNOSTIC/);
});

test('unresolved review extraction ignores harmless prose and keeps explicit request changes verdicts', async () => {
  const fixture = makeFixtureRepo();
  const rootDir = makeRootWithFamily(fixture);
  const packet = await buildFixturePacketWithOptions(rootDir, fixture.repoDir, {
    skipGithub: false,
    fetchRollupImpl: async (_repo, prNumber) => ({
      state: 'OPEN',
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      checks: [],
      comments: [],
      reviews: prNumber === 6466 ? [
        {
          state: 'COMMENTED',
          author: { login: 'reviewer' },
          submittedAt: '2026-09-11T12:00:00Z',
          body: 'There is no blocking finding here; keep going.',
        },
      ] : [
        {
          state: 'COMMENTED',
          author: { login: 'reviewer' },
          submittedAt: '2026-09-11T12:01:00Z',
          body: '## Verdict\n\nRequest changes',
        },
      ],
    }),
  });
  const markdown = packet.files['reviews.md'];

  assert.match(
    markdown,
    /## PR #6466[\s\S]*There is no blocking finding here[\s\S]*### Unresolved Findings\s+\n- \(none detected from latest review bodies\)/
  );
  assert.match(
    markdown,
    /## PR #6463[\s\S]*### Unresolved Findings\s+\n- COMMENTED by reviewer at 2026-09-11T12:01:00Z/
  );
});

test('report skeleton uses corpus-style sections and relative packet links', async () => {
  const fixture = makeFixtureRepo();
  const rootDir = makeRootWithFamily(fixture);
  const packet = await buildFixturePacket(rootDir, fixture.repoDir);
  const skeleton = packet.files['report-skeleton.md'];

  assert.match(skeleton, /^# 2026-09-11 DPA-03 Duplicate PR Divergence: #6463 vs #6466/m);
  for (const heading of ['## Pair', '## Decision', '## Comparison', '## Salvage Folded Into Survivor', '## Divergence Notes', '## Validation']) {
    assert.match(skeleton, new RegExp(`^${heading}$`, 'm'));
  }
  for (const link of [
    'family.json',
    'range-diff.txt',
    'reviews.md',
    'comments.md',
    'candidate-6463.diffstat.txt',
    'candidate-6466.stale-base-diagnostic.txt',
  ]) {
    assert.match(skeleton, new RegExp(`\\(${link.replace('.', '\\.')}\\)`));
  }
  rmSync(rootDir, { recursive: true, force: true });
});
