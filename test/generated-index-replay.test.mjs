import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recoverTerminalCommentOnlyRound } from '../src/comment-only-final-round-recovery.mjs';
import { resolveSettledReviewVerdict } from '../src/adversarial-gate-status.mjs';
import { summarizePRRemediationLedger } from '../src/follow-up-jobs.mjs';
const { proveFinalRoundWorkerPush, hasCommentOnlyFinalRoundPush, hasUnprovenCommentOnlyFinalRoundHead,
  findCommentOnlyFinalRoundPushJob } = await import(process.env.PMSC14_OBSERVER_MODULE || '../src/comment-only-final-round.mjs');

const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env }).trim();
const implementationPath = (n) => n === 2 ? 'docs/reviewed.md' : `feature${n}.txt`;
const commit = (dir, message) => { git(dir, 'add', '--all'); git(dir, 'commit', '-qm', message); return git(dir, 'rev-parse', 'HEAD'); };
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pmsc14-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, 'init', '-qb', 'main');
  mkdirSync(join(dir, 'docs')); mkdirSync(join(dir, 'scripts'));
  writeFileSync(join(dir, 'scripts/check-generated-index-pr-diff.py'), readFileSync(new URL('./fixtures/generated-index-policy/check-generated-index-pr-diff.py.txt', import.meta.url)));
  writeFileSync(join(dir, '.gitattributes'), 'docs/INDEX.md merge=agentos-docs-index\n');
  writeFileSync(join(dir, 'docs/INDEX.md'), 'original index\n');
  writeFileSync(join(dir, 'code.txt'), 'base\n');
  const base = commit(dir, 'base');
  git(dir, 'checkout', '-qb', 'reviewed');
  const commits = [];
  for (let n = 1; n <= 3; n++) {
    writeFileSync(join(dir, implementationPath(n)), `implementation ${n}\n`);
    if (n === 1) writeFileSync(join(dir, 'docs/reviewed.md'), 'first reviewed doc\n');
    if (n !== 2) writeFileSync(join(dir, 'docs/INDEX.md'), `intermediate index ${n}\n`);
    commits.push(commit(dir, `mixed ${n}`));
  }
  writeFileSync(join(dir, 'docs/INDEX.md'), 'original index\n');
  const reviewedHead = commit(dir, 'INDEX-only reset');
  git(dir, 'checkout', '-q', 'main');
  writeFileSync(join(dir, 'docs/INDEX.md'), 'fresh authoritative index\n');
  writeFileSync(join(dir, 'trunk.txt'), 'fresh trunk\n');
  const freshBase = commit(dir, 'fresh base');
  git(dir, 'update-ref', 'refs/remotes/origin/main', freshBase);
  git(dir, 'checkout', '-qb', 'push');
  for (let n = 1; n <= 3; n++) {
    writeFileSync(join(dir, implementationPath(n)), `implementation ${n}\n`);
    if (n === 1) writeFileSync(join(dir, 'docs/reviewed.md'), 'first reviewed doc\n');
    commit(dir, `replay ${n}`);
  }
  writeFileSync(join(dir, 'fix.txt'), 'job remediation\n');
  const head = commit(dir, 'remediation\n\nWorker-Job-Id: job-42');
  const args = { repo: 'laceyenterprises/agent-os', prNumber: 7544, jobId: 'job-42', reviewedHead,
    baseBranch: 'main', workspaceDir: dir, log: { warn() {} },
    execFileImpl: async (command, argv, options) => command === 'gh'
      ? { stdout: argv[0] === 'api' ? freshBase : git(dir, 'rev-parse', 'HEAD') }
      : { stdout: execFileSync(command, argv, { ...options, encoding: 'utf8', env }) } };
  return { dir, args, head, base, freshBase, commits, reviewedHead };
}

test('PMSC-14: mixed INDEX commits and INDEX-only reset replay intact onto fresh governed base', async (t) => {
  const { args, head } = fixture(t);
  const result = await proveFinalRoundWorkerPush(args);
  assert.equal(result.workerPushedHeadSha, head, result.reason);
  assert.equal(result.proof.generatedIndexPolicy, 'agent-os-main-index-v1');
});

test('PMSC-14: force-push during proof withholds authority', async (t) => {
  const { args, dir } = fixture(t);
  args.reviewedHead = git(dir, 'rev-parse', 'HEAD~1');
  let reads = 0;
  const original = args.execFileImpl;
  args.execFileImpl = async (command, argv, options) => {
    if (command === 'gh' && argv[0] === 'pr' && ++reads > 1) return { stdout: 'f'.repeat(40) };
    return original(command, argv, options);
  };
  const result = await proveFinalRoundWorkerPush(args);
  assert.equal(result.workerPushedHeadSha, null);
  assert.match(result.reason, /changed-during-proof/);
});

for (const [name, mutate] of [
  ['unknown repository', ({ args }) => { args.repo = 'example/repo'; }],
  ['unknown base policy', ({ args }) => { args.baseBranch = 'release'; }],
  ['wrong authoritative base', ({ args, base }) => {
    const original = args.execFileImpl;
    args.execFileImpl = async (cmd, argv, options) => cmd === 'gh' && argv[0] === 'api'
      ? { stdout: base } : original(cmd, argv, options);
  }],
  ['stale head', ({ args }) => {
    const original = args.execFileImpl;
    args.execFileImpl = async (cmd, argv, options) => cmd === 'gh' && argv[0] === 'pr'
      ? { stdout: 'f'.repeat(40) } : original(cmd, argv, options);
  }],
  ['malicious index payload', ({ dir }) => {
    writeFileSync(join(dir, 'docs/INDEX.md'), 'payload\n'); commit(dir, 'payload\n\nWorker-Job-Id: job-42');
  }],
  ['index payload cumulatively cancelled', ({ dir }) => {
    writeFileSync(join(dir, 'docs/INDEX.md'), 'payload\n'); commit(dir, 'payload\n\nWorker-Job-Id: job-42');
    writeFileSync(join(dir, 'docs/INDEX.md'), 'fresh authoritative index\n'); commit(dir, 'cancel payload\n\nWorker-Job-Id: job-42');
  }],
  ['foreign commit before final job fix', ({ dir }) => {
    writeFileSync(join(dir, 'foreign.txt'), 'foreign\n'); commit(dir, 'foreign');
    writeFileSync(join(dir, 'fix2.txt'), 'fix\n'); commit(dir, 'fix\n\nWorker-Job-Id: job-42');
  }],
  ['body trailer followed by prose', ({ dir }) => { git(dir, 'commit', '--amend', '-qm', 'Worker-Job-Id: job-42\n\nThis is prose.'); }],
  ['duplicate conflicting trailers', ({ dir }) => { git(dir, 'commit', '--amend', '-qm', 'fix\n\nWorker-Job-Id: foreign\nWorker-Job-Id: job-42'); }],
  ['crafted job identifier', ({ args }) => { args.jobId = 'job-42\nInjected: yes'; }],
  ['missing reviewed object', ({ args }) => { args.reviewedHead = 'f'.repeat(40); }],
  ['unreadable Git object', ({ args }) => {
    const original = args.execFileImpl;
    args.execFileImpl = async (cmd, argv, options) => {
      if (cmd === 'git' && argv.includes('diff')) throw new Error(`unreadable object ${'x'.repeat(5000)}`);
      return original(cmd, argv, options);
    };
  }],
  ['changed governance', ({ dir, args }) => {
    git(dir, 'checkout', '-q', 'main'); writeFileSync(join(dir, 'scripts/check-generated-index-pr-diff.py'), '# unknown\n');
    const changed = commit(dir, 'unknown governance'); git(dir, 'update-ref', 'refs/remotes/origin/main', changed);
    git(dir, 'checkout', '-q', 'push'); args.execFileImpl = async (cmd, argv, options) => cmd === 'gh'
      ? { stdout: argv[0] === 'api' ? changed : git(dir, 'rev-parse', 'HEAD') }
      : { stdout: execFileSync(cmd, argv, { ...options, encoding: 'utf8', env }) };
  }],
]) {
  test(`PMSC-14 rejects ${name}`, async (t) => {
    const f = fixture(t); mutate(f);
    const result = await proveFinalRoundWorkerPush(f.args);
    assert.equal(result.workerPushedHeadSha, null, result.reason);
    assert.ok(result.reason.length < 2200, 'Git diagnostic is bounded');
  });
}

for (const mode of ['changed', 'dropped', 'cancelled', 'conflicting-trunk', 'renamed', 'foreign-trailer']) {
  test(`PMSC-14 rejects ${mode} reviewed implementation despite endpoint resemblance`, async (t) => {
    const f = fixture(t);
    git(f.dir, 'reset', '--hard', f.freshBase);
    for (let n = 1; n <= 3; n++) {
      if (mode === 'dropped' && n === 2) continue;
      writeFileSync(join(f.dir, implementationPath(n)), mode === 'changed' && n === 2 ? 'changed\n' : `implementation ${n}\n`);
      if (n === 1) writeFileSync(join(f.dir, 'docs/reviewed.md'), 'first reviewed doc\n');
      if (mode === 'renamed' && n === 2) git(f.dir, 'mv', 'feature1.txt', 'renamed.txt');
      commit(f.dir, mode === 'foreign-trailer' && n === 2 ? 'foreign\n\nWorker-Job-Id: job-42' : `replay ${n}`);
    }
    if (mode === 'cancelled') {
      // Both reviewed patches are present in history, but one omitted patch was
      // cancelled on the reviewed branch: an endpoint-only proof would miss it.
      git(f.dir, 'checkout', '-q', 'reviewed');
      writeFileSync(join(f.dir, 'cancel.txt'), 'temporary\n'); commit(f.dir, 'reviewed temporary');
      rmSync(join(f.dir, 'cancel.txt')); f.args.reviewedHead = commit(f.dir, 'reviewed cancellation');
      git(f.dir, 'checkout', '-q', 'push');
    }
    if (mode === 'conflicting-trunk') {
      git(f.dir, 'checkout', '-q', 'main'); writeFileSync(join(f.dir, 'docs/reviewed.md'), 'trunk implementation\n');
      const base = commit(f.dir, 'conflicting trunk'); git(f.dir, 'update-ref', 'refs/remotes/origin/main', base);
      git(f.dir, 'checkout', '-q', 'push');
    }
    if (mode === 'foreign-trailer') {
      // An unrelated same-job commit cannot substitute for a missing reviewed patch.
      git(f.dir, 'reset', '--hard', 'HEAD~2');
      writeFileSync(join(f.dir, 'docs/reviewed.md'), 'substituted\n'); commit(f.dir, 'foreign\n\nWorker-Job-Id: job-42');
    }
    writeFileSync(join(f.dir, 'fix.txt'), 'fix\n'); commit(f.dir, 'fix\n\nWorker-Job-Id: job-42');
    const result = await proveFinalRoundWorkerPush(f.args);
    assert.equal(result.workerPushedHeadSha, null, result.reason);
  });
}

test('PMSC-14 rejects merge commits and index rename tricks', async (t) => {
  for (const rename of [false, true]) {
    const f = fixture(t);
    if (rename) {
      git(f.dir, 'mv', 'docs/INDEX.md', 'docs/INDEX.md.extra');
      commit(f.dir, 'rename\n\nWorker-Job-Id: job-42');
    } else {
      git(f.dir, 'checkout', '-qb', 'side', f.freshBase);
      writeFileSync(join(f.dir, 'side.txt'), 'side\n'); commit(f.dir, 'side');
      git(f.dir, 'checkout', '-q', 'push'); git(f.dir, 'merge', '--no-ff', '-qm', 'merge', 'side');
      writeFileSync(join(f.dir, 'fix2.txt'), 'fix\n'); commit(f.dir, 'fix\n\nWorker-Job-Id: job-42');
    }
    assert.equal((await proveFinalRoundWorkerPush(f.args)).workerPushedHeadSha, null);
  }
});

function stoppedFixture(t) {
  const f = fixture(t);
  const rootDir = mkdtempSync(join(tmpdir(), 'pmsc14-native-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const jobId = 'laceyenterprises__agent-os-pr-7544-final';
  git(f.dir, 'commit', '--amend', '-qm', `fix\n\nWorker-Job-Id: ${jobId}`);
  const head = git(f.dir, 'rev-parse', 'HEAD');
  const stopped = join(rootDir, 'data/follow-up-jobs/stopped'); mkdirSync(stopped, { recursive: true });
  const replyPath = join(rootDir, 'reply.json');
  writeFileSync(replyPath, JSON.stringify({ kind: 'adversarial-review-remediation-reply', schemaVersion: 1,
    jobId, repo: f.args.repo, prNumber: 7544, outcome: 'partial', summary: 'Remediated the finding.',
    validation: ['isolated fixture validation'], blockers: [], operationalBlockers: [], addressed: [], pushback: [],
    reReview: { requested: false, reason: null } }));
  const job = { jobId, repo: f.args.repo, prNumber: 7544, baseBranch: 'main', revisionRef: f.reviewedHead,
    status: 'stopped', finalRound: 'comment-only', reviewBody: '## Verdict\nComment only',
    reReview: { suppressed: 'comment-only-final-round' }, remediationPlan: { currentRound: 1, stop: { code: 'no-progress' } },
    remediationWorker: { state: 'completed', dispatchMode: 'hq', dispatchId: 'fixture-native-42', replyPath },
    remediationReply: { path: replyPath }, stoppedAt: '2026-10-02T10:39:30Z',
    completion: { withheldPushHeadSha: head, finalRoundOutcome: { completed: false, reason: 'no-proven-push',
      push: `reviewed-commit-not-replayed ${f.commits[0].slice(0, 12)}` } } };
  const jobPath = join(stopped, `${jobId}.json`); writeFileSync(jobPath, JSON.stringify(job));
  const original = f.args.execFileImpl;
  const execFileImpl = async (cmd, argv, options) => cmd === 'gh' && argv.includes('state,headRefOid')
    ? { stdout: JSON.stringify({ state: 'OPEN', headRefOid: head }) } : original(cmd, argv, options);
  const options = { rootDir, jobId, workspaceDir: f.dir, execFileImpl,
    livenessImpl: async () => ({ state: 'exited', reason: 'hq-dispatch-completed' }),
    ciImpl: async () => ({ headSha: head, state: 'green' }), log: { warn() {}, error() {} } };
  return { ...f, job, jobId, jobPath, rootDir, options, head, replyPath };
}

test('PMSC-14 terminal recovery appends proof, preserves failure bytes, and reaches every closeout sibling', async (t) => {
  const f = stoppedFixture(t);
  const query = { repo: f.job.repo, prNumber: 7544, headSha: f.head };
  const before = readFileSync(f.jobPath);
  assert.equal(hasUnprovenCommentOnlyFinalRoundHead(f.rootDir, query), true);
  const preview = await recoverTerminalCommentOnlyRound(f.options);
  assert.equal(preview.action, 'preview'); assert.equal(preview.record.completed, true);
  assert.equal(hasCommentOnlyFinalRoundPush(f.rootDir, query), false);
  const applied = await recoverTerminalCommentOnlyRound({ ...f.options, apply: true });
  assert.equal(applied.action, 'recovered');
  assert.deepEqual(readFileSync(f.jobPath), before);
  assert.equal(hasUnprovenCommentOnlyFinalRoundHead(f.rootDir, query), false);
  assert.equal(hasCommentOnlyFinalRoundPush(f.rootDir, query), true);
  assert.equal(findCommentOnlyFinalRoundPushJob(f.rootDir, { ...query, reviewedHead: f.reviewedHead,
    workerPushedHeadSha: f.head }).completion.finalRoundOutcome.completed, false, 'original failure retained in derived job');
  const ledger = summarizePRRemediationLedger(f.rootDir, query);
  assert.equal(ledger.commentOnlyFinalRoundPushedHeads[0].workerPushedHeadSha, f.head);
  const verdict = resolveSettledReviewVerdict(f.rootDir, { repo: f.job.repo, prNumber: 7544,
    reviewRow: { reviewer_head_sha: f.reviewedHead, review_status: 'posted' }, currentHeadSha: f.head,
    commentOnlyFinalRoundPushes: ledger.commentOnlyFinalRoundPushedHeads });
  assert.equal(verdict.verdict, 'comment-only');
  assert.equal(verdict.reviewedHeadSha, f.reviewedHead);
  assert.equal((await recoverTerminalCommentOnlyRound({ ...f.options, apply: true })).action, 'already-recovered');
});

for (const mode of ['active-worker', 'active-followup', 'review-blocker', 'changed-source', 'changed-reply', 'terminal-pr', 'attempt-limit']) {
  test(`PMSC-14 terminal recovery fails closed on ${mode}`, async (t) => {
    const f = stoppedFixture(t);
    if (mode === 'active-worker') f.options.livenessImpl = async () => ({ state: 'active' });
    if (mode === 'active-followup') {
      const dir = join(f.rootDir, 'data/follow-up-jobs/pending'); mkdirSync(dir);
      writeFileSync(join(dir, 'active.json'), JSON.stringify({ repo: f.job.repo, prNumber: 7544 }));
    }
    if (mode === 'review-blocker') {
      const reply = JSON.parse(readFileSync(f.replyPath)); reply.blockers = [{ finding: 'Still unresolved', needsHumanInput: 'Review the blocker' }];
      writeFileSync(f.replyPath, JSON.stringify(reply));
      const result = await recoverTerminalCommentOnlyRound({ ...f.options, apply: true });
      assert.equal(result.action, 'withheld');
      assert.equal(hasCommentOnlyFinalRoundPush(f.rootDir, { repo: f.job.repo, prNumber: 7544, headSha: f.head }), false);
      return;
    }
    if (['changed-source', 'changed-reply'].includes(mode)) {
      let calls = 0;
      f.options.livenessImpl = async () => {
        if (++calls === 2) {
          const path = mode === 'changed-source' ? f.jobPath : f.replyPath;
          const data = JSON.parse(readFileSync(path)); data.summary = 'changed'; writeFileSync(path, JSON.stringify(data));
        }
        return { state: 'exited' };
      };
    }
    if (mode === 'terminal-pr') {
      const exec = f.options.execFileImpl;
      f.options.execFileImpl = async (cmd, argv, opts) => cmd === 'gh' && argv.includes('state,headRefOid')
        ? { stdout: JSON.stringify({ state: 'MERGED', headRefOid: f.head }) } : exec(cmd, argv, opts);
    }
    if (mode === 'attempt-limit') {
      const dir = join(f.rootDir, 'data/follow-up-jobs/final-round-recoveries'); mkdirSync(dir);
      for (let n = 1; n <= 3; n++) writeFileSync(join(dir, `${f.jobId}.${n}.json`), '{}');
    }
    await assert.rejects(recoverTerminalCommentOnlyRound({ ...f.options, apply: true }));
  });
}

for (const race of ['remote', 'local', 'base']) {
  test(`PMSC-14 repeats the ${race} proof fence five times`, async (t) => {
    for (let n = 0; n < 5; n++) {
      const f = fixture(t);
      let reads = 0;
      const exec = f.args.execFileImpl;
      f.args.execFileImpl = async (cmd, argv, opts) => {
        if (cmd === 'gh' && argv[0] === 'pr' && ++reads === 2) {
          if (race === 'remote') return { stdout: 'f'.repeat(40) };
          if (race === 'local') git(f.dir, 'update-ref', 'HEAD', f.freshBase);
          if (race === 'base') git(f.dir, 'update-ref', 'refs/remotes/origin/main', f.base);
        }
        return exec(cmd, argv, opts);
      };
      const result = await proveFinalRoundWorkerPush(f.args);
      assert.equal(result.workerPushedHeadSha, null, `${race} iteration ${n}: ${result.reason}`);
      assert.match(result.reason, /changed-during-proof/);
    }
  });
}

test('PMSC-14 rejects corrupted real Git objects and symlink index entries', async (t) => {
  const broken = fixture(t);
  const object = join(broken.dir, '.git/objects', broken.reviewedHead.slice(0, 2), broken.reviewedHead.slice(2));
  chmodSync(object, 0o600);
  writeFileSync(object, 'corrupt object');
  assert.equal((await proveFinalRoundWorkerPush(broken.args)).workerPushedHeadSha, null);
  const linked = fixture(t);
  // Write a symlink directly into the Git index so platform filesystem behavior
  // cannot turn the fixture into a normal file.
  const blob = git(linked.dir, 'hash-object', '-w', 'code.txt');
  git(linked.dir, 'update-index', '--cacheinfo', `120000,${blob},docs/INDEX.md`);
  git(linked.dir, 'commit', '-qm', 'symlink\n\nWorker-Job-Id: job-42');
  assert.equal((await proveFinalRoundWorkerPush(linked.args)).workerPushedHeadSha, null);
});

test('PMSC-14 recovery remains valid after archival and rejects changed historical evidence', async (t) => {
  const f = stoppedFixture(t);
  await recoverTerminalCommentOnlyRound({ ...f.options, apply: true });
  const dir = join(f.rootDir, 'data/follow-up-jobs/stopped-archived/2026-10'); mkdirSync(dir, { recursive: true });
  const { renameSync } = await import('node:fs');
  const archived = join(dir, `${f.jobId}.json`); renameSync(f.jobPath, archived);
  const query = { repo: f.job.repo, prNumber: 7544, headSha: f.head };
  assert.equal(hasCommentOnlyFinalRoundPush(f.rootDir, query), true);
  assert.equal(summarizePRRemediationLedger(f.rootDir, query).commentOnlyFinalRoundPushedHeads[0].workerPushedHeadSha, f.head);
  assert.equal((await recoverTerminalCommentOnlyRound({ ...f.options, apply: true })).action, 'already-recovered');
  const job = JSON.parse(readFileSync(archived)); job.completion.finalRoundOutcome.reason = 'changed evidence';
  writeFileSync(archived, JSON.stringify(job));
  assert.equal(hasCommentOnlyFinalRoundPush(f.rootDir, query), false);
  assert.equal(hasUnprovenCommentOnlyFinalRoundHead(f.rootDir, query), true);
});


test('PMSC-14 fixture preserves the captured PR7544 replay shape and historical IDs', () => {
  const records = JSON.parse(readFileSync(new URL('./fixtures/generated-index-policy/pr7544-replay-evidence.json', import.meta.url)));
  assert.deepEqual(records.slice(0, 3).map((record) => record.oldPaths.includes('docs/INDEX.md')), [true, false, true]);
  for (const record of records.slice(0, 3)) {
    assert.equal(record.oldImplementationPatchId, record.newImplementationPatchId);
    assert.deepEqual(record.oldPaths.filter((path) => path !== 'docs/INDEX.md'), record.newPaths);
  }
  assert.deepEqual(records[3].paths, ['docs/INDEX.md']);
  assert.equal(records[3].omittedResetCommit, 'adc88d1635');
  assert.equal(records[3].head, '6028e2a63ec132b02ed857ec2a9e44c81da9a0ef');
  assert.equal(records[3].finalIndexMatchesTrunk, true);
});

test('PMSC-14 delayed native recovery accepts only unrelated authoritative main advancement', async (t) => {
  for (const path of ['later-trunk.txt', 'docs/reviewed.md', 'docs/INDEX.md', 'scripts/check-generated-index-pr-diff.py']) {
    const f = stoppedFixture(t);
    git(f.dir, 'checkout', '-q', 'main');
    writeFileSync(join(f.dir, path), 'later trunk\n');
    const currentBase = commit(f.dir, 'later main');
    git(f.dir, 'update-ref', 'refs/remotes/origin/main', currentBase);
    git(f.dir, 'checkout', '-q', 'push');
    const exec = f.options.execFileImpl;
    f.options.execFileImpl = async (cmd, argv, opts) => cmd === 'gh' && argv[0] === 'api'
      ? { stdout: currentBase } : exec(cmd, argv, opts);
    const result = await recoverTerminalCommentOnlyRound(f.options);
    assert.equal(result.record.completed, path === 'later-trunk.txt', `${path}: ${JSON.stringify(result.record.completion)}`);
    if (path === 'later-trunk.txt') {
      assert.equal(result.record.completion.workerPushProof.authoritativeBase, currentBase);
      assert.equal(result.record.completion.workerPushProof.rebaseBase, f.freshBase);
    }
  }
});

test('PMSC-14 never excludes sibling generated paths, nested indexes, reviewed tests or lookalike names', async (t) => {
  for (const path of ['projects/INDEX.md', 'docs/nested/INDEX.md', 'test/reviewed.test.mjs', 'docs/INDEX.md.extra']) {
    const f = fixture(t);
    git(f.dir, 'checkout', '-q', 'reviewed');
    const { dirname } = await import('node:path');
    mkdirSync(dirname(join(f.dir, path)), { recursive: true });
    writeFileSync(join(f.dir, path), 'reviewed content must survive\n');
    writeFileSync(join(f.dir, 'docs/INDEX.md'), 'mixed index update\n');
    f.args.reviewedHead = commit(f.dir, 'reviewed additional path');
    git(f.dir, 'checkout', '-q', 'push');
    assert.equal((await proveFinalRoundWorkerPush(f.args)).workerPushedHeadSha, null, path);
  }
});
