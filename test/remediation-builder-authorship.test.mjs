import './helpers/registry-session-fixture.mjs';
import './helpers/load-aware-timeout-fixture.mjs';
import './helpers/rate-limit-state-isolation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeBuilderClass, isCrossModelReviewWaived } from '../src/adapters/subject/github-pr/routing.mjs';
import { CLASS_ALIASES } from '../src/worker-class-aliases.mjs';
import { deriveRemediationBuilder, readRemediationBuilderEvidence, recoverRemediationBuilder } from '../src/remediation-builder-authorship.mjs';
import { pickRemediationWorkerClass } from '../src/remediation-worker-routing.mjs';
import { resolveRemediationWorkerClassWithFallback } from '../src/remediation-worker-class-fallback.mjs';
import { consumeNextFollowUpJob } from '../src/follow-up-remediation.mjs';
import { createFollowUpJob, isRetriggerableStoppedFollowUpJob } from '../src/follow-up-jobs.mjs';

const AT = '2026-01-01T00:00:00.000Z';
const env = { AGENT_OS_CONFIG_PATH: '/dev/null' };
const quiet = { log() {}, warn() {}, error() {} };
function fixture(t, builderTag = null) {
  const rootDir = mkdtempSync(join(tmpdir(), 'builder-authorship-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const job = { jobId: 'synthetic-pr-7', repo: 'example/service', prNumber: 7,
    domainId: 'code-pr', builderTag, status: 'in_progress', reviewerModel: 'gemini',
    remediationPlan: { currentRound: 0, maxRounds: 3, rounds: [] } };
  const jobPath = join(rootDir, 'data/follow-up-jobs/in-progress', `${job.jobId}.json`);
  mkdirSync(join(rootDir, 'data/follow-up-jobs/in-progress'), { recursive: true });
  writeFileSync(jobPath, JSON.stringify(job));
  return { rootDir, jobPath, job };
}

const vocabulary = {
  codex: ['codex', 'codex-corp', 'remediator-codex', 'remediator-codex-corp', 'hammer', 'hammer-corp', 'codex-remediation'],
  'claude-code': ['claude', 'claude-code', 'claude-code-corp', 'remediator-claude',
    'remediator-claude-corp', 'hammer-claude', 'hammer-claude-corp', 'claude-code-remediation'],
  'clio-agent': ['clio', 'clio-agent'],
  gemini: ['gemini', 'remediator-gemini', 'gemini-remediation'],
  grok: ['grok', 'grok-api', 'grok-reviewer', 'remediator-grok', 'hammer-grok'],
  pi: ['pi'], opencode: ['opencode'], hermes: ['hermes'],
};
for (const [family, values] of Object.entries(vocabulary)) {
  for (const value of values) test(`normalizes recorded builder value ${value}`, () => {
    assert.equal(normalizeBuilderClass(value), family);
    assert.equal(normalizeBuilderClass(` [${value.toUpperCase()}] `), family);
  });
}
test('corporate builder aliases in the published vocabulary retain their canonical family', () => {
  for (const [alias, [canonical]] of Object.entries(CLASS_ALIASES)) {
    if (canonical === 'claude-reviewer') continue; // Reviewer identity is never builder evidence.
    assert.ok(normalizeBuilderClass(alias), alias);
    assert.equal(normalizeBuilderClass(alias), normalizeBuilderClass(canonical));
  }
  assert.equal(normalizeBuilderClass('future-unknown-builder'), null);
});

for (const [tag, evidence, expected] of [
  [null, { title: '[codex] Synthetic fix' }, 'codex'],
  ['obsolete-value', { openerClasses: ['claude-code-corp'] }, 'claude-code'],
  ['', { body: 'Worker-Class: codex-corp' }, 'codex'],
]) test(`recovers ${JSON.stringify(tag)} and selects a different remediator family`, async t => {
  const f = fixture(t, tag);
  const lines = [];
  const result = await recoverRemediationBuilder({ ...f, now: () => AT,
    log: { warn: line => lines.push(line) }, readEvidenceImpl: async () => evidence });
  assert.equal(result.ok, true);
  const persisted = JSON.parse(readFileSync(f.jobPath));
  assert.equal(persisted.builderTag, expected);
  assert.equal(persisted.builderTagRecovery.previousTag, tag);
  assert.equal(persisted.builderTagRecovery.observedAt, AT);
  assert.match(lines[0], /job=synthetic-pr-7 builder-tag-derived/);
  const primary = pickRemediationWorkerClass(persisted, { env });
  const routing = await resolveRemediationWorkerClassWithFallback({ primary, job: persisted,
    env, codexAccountPolicy: 'pinned', fallbackWorkerClasses: [], execFileImpl: null,
    modelForClass: () => 'synthetic-model', ensureWorkerRegistryReadyImpl: async () => {} });
  assert.equal(routing.hold, false);
  assert.equal(isCrossModelReviewWaived(expected, routing.workerClass), false);
  const refused = await resolveRemediationWorkerClassWithFallback({ primary: expected, job: persisted,
    env, execFileImpl: null, ensureWorkerRegistryReadyImpl: async () => assert.fail('must refuse before selection') });
  assert.equal(refused.reason, 'builder-cannot-remediate-own-pr');
});

test('reader uses PR-scoped opener provenance and bounded PR metadata transport', async () => {
  const evidence = await readRemediationBuilderEvidence({ rootDir: '/synthetic', job: {
    repo: 'example/service', prNumber: 7, revisionRef: 'moved-head',
  }, env, execFileImpl: async (bin, args, options) => {
    assert.equal(bin, 'gh');
    assert.deepEqual(args, ['pr', 'view', '7', '--repo', 'example/service', '--json', 'title,body']);
    assert.ok(options.timeout > 0);
    return { stdout: JSON.stringify({ title: '[codex] Synthetic fix', body: '' }) };
  }, readIdentityImpl: async args => {
    assert.equal(args.repo, 'example/service');
    assert.equal(args.prNumber, 7);
    assert.equal(args.headSha, undefined);
    return { ok: true, rows: [{ worker_class: 'codex-corp' }] };
  } });
  assert.equal(deriveRemediationBuilder(evidence).builderTag, 'codex');
});

test('conflicting evidence never overwrites a legacy job and names escalation evidence', async t => {
  const f = fixture(t, 'obsolete-value');
  const result = await recoverRemediationBuilder({ ...f, now: () => AT, readEvidenceImpl: async () => ({
    title: '[codex] Synthetic fix', openerClasses: ['claude-code-corp'],
  }) });
  assert.equal(result.ok, false);
  assert.equal(result.stopCode, 'conflicting-builder-authorship');
  for (const named of ['synthetic-pr-7', 'title-prefix', 'pr_opened.worker_class', 'body.Worker-Class', 'Owner:', 'Next action:']) {
    assert.ok(result.reason.includes(named), named);
  }
  assert.equal(JSON.parse(readFileSync(f.jobPath)).builderTag, 'obsolete-value');
});

for (const evidence of [{}, { title: 'untagged', openerClasses: ['unknown'] }]) {
  test(`absent recognizable authorship escalates: ${JSON.stringify(evidence)}`, async t => {
    const f = fixture(t);
    const result = await recoverRemediationBuilder({ ...f, readEvidenceImpl: async () => evidence });
    assert.equal(result.stopCode, 'missing-builder-authorship');
    assert.match(result.reason, /missing evidence=title-prefix, pr_opened.worker_class, body.Worker-Class/);
  });
}

test('source failures become an explicit escalation rather than a generic retry', async t => {
  const f = fixture(t);
  const result = await recoverRemediationBuilder({ ...f, readEvidenceImpl: async () => { throw Error('offline'); } });
  assert.equal(result.stopCode, 'missing-builder-authorship');
  assert.equal(result.escalation.evidence.availability.pr_opened, 'unavailable');
});

test('known tags and non-code subjects do not read or rewrite authorship', async t => {
  const f = fixture(t, 'codex-corp');
  for (const job of [f.job, { ...f.job, domainId: 'research', builderTag: null }]) {
    assert.equal((await recoverRemediationBuilder({ ...f, job,
      readEvidenceImpl: () => assert.fail('unexpected evidence read') })).job, job);
  }
});

test('body and title conflicts refuse; compatible Clio/Codex families agree', () => {
  assert.equal(deriveRemediationBuilder({ title: '[codex] Fix', body: 'Worker-Class: claude-code' }).ok, false);
  assert.equal(deriveRemediationBuilder({ title: '[clio-agent] Fix', openerClasses: ['codex-corp'] }).ok, true);
  assert.equal(deriveRemediationBuilder({ body: 'Example Worker-Class: codex' }).ok, false);
  assert.equal(deriveRemediationBuilder({ body: '```\nWorker-Class: codex\n```' }).ok, false);
  assert.equal(deriveRemediationBuilder({ body: '~~~example\nWorker-Class: codex' }).ok, false);
  assert.equal(deriveRemediationBuilder({ body: '```\nexample\n```\nWorker-Class: codex' }).ok, true);
});

test('claim consumer persists recovered authorship before routing a legacy job', async t => {
  const f = fixture(t);
  rmSync(f.jobPath);
  createFollowUpJob({ rootDir: f.rootDir, jobId: f.job.jobId, repo: f.job.repo,
    prNumber: 7, branch: 'synthetic/fix', builderTag: 'obsolete-value', reviewerModel: 'gemini',
    reviewBody: '## Blocking issues\n- Synthetic finding\n\n## Verdict\nRequest changes', createdAt: AT });
  let routed = false;
  const result = await consumeNextFollowUpJob({ rootDir: f.rootDir, promptTemplate: 'synthetic',
    ensureWorkerRegistryReadyImpl: async () => {}, now: () => AT,
    resolvePRLifecycleImpl: async () => ({ prState: 'open' }),
    readBuilderEvidenceImpl: async () => ({ openerClasses: ['codex-corp'] }),
    resolveRemediationWorkerClassImpl: async args => {
      routed = true;
      assert.equal(args.job.builderTag, 'codex');
      assert.equal(isCrossModelReviewWaived('codex', args.primary), false);
      const claimedPath = join(f.rootDir, 'data/follow-up-jobs/in-progress', `${args.job.jobId}.json`);
      assert.equal(JSON.parse(readFileSync(claimedPath)).builderTag, 'codex');
      return { workerClass: args.primary, hold: true, reason: 'synthetic-cap',
        holdUntil: '2026-01-01T00:15:00.000Z' };
    },
    spawnImpl: () => assert.fail('synthetic quota hold must not spawn'), log: quiet });
  assert.equal(routed, true);
  assert.equal(result.job.builderTag, 'codex');
  assert.equal(result.job.status, 'pending');
  assert.equal(result.job.builderTagRecovery.previousTag, 'obsolete-value');
});

for (const seam of ['pool', 'experiment']) test(`recovered builder cannot remediate itself after ${seam} routing`, async t => {
  const f = fixture(t);
  rmSync(f.jobPath);
  createFollowUpJob({ rootDir: f.rootDir, repo: f.job.repo, prNumber: 7,
    branch: 'synthetic/fix', builderTag: null, reviewerModel: 'gemini',
    reviewBody: '## Blocking issues\n- Synthetic finding\n\n## Verdict\nRequest changes' });
  const result = await consumeNextFollowUpJob({ rootDir: f.rootDir, promptTemplate: 'synthetic',
    ensureWorkerRegistryReadyImpl: async () => {}, now: () => AT,
    resolvePRLifecycleImpl: async () => ({ prState: 'open' }),
    readBuilderEvidenceImpl: async () => ({ title: '[codex] Synthetic fix' }),
    healthRouter: { getMode: () => 'os' },
    resolveRemediationWorkerClassImpl: async args => ({
      workerClass: seam === 'pool' ? 'remediator-codex-corp' : args.primary, hold: false,
    }),
    resolveOsgRemediatorRouteImpl: async () => {
      assert.equal(seam, 'experiment');
      return { workerClass: 'remediator-codex', hold: false };
    },
    spawnImpl: () => assert.fail('own-family routing must stop before spawn'), log: quiet });
  assert.equal(result.job.status, 'stopped');
  assert.equal(result.job.remediationPlan.stop.code, 'builder-cannot-remediate-own-pr');
  assert.equal(result.job.remediationPlan.stop.builderAuthorshipEscalation.owner, 'adversarial-review operator');
  assert.ok(isRetriggerableStoppedFollowUpJob(result.job));
});

for (const evidence of [{}, { title: '[codex] Synthetic fix', openerClasses: ['claude-code'] }]) {
  test('claim consumer stops with durable operator ownership, no spawn or quota retry', async t => {
    const f = fixture(t);
    rmSync(f.jobPath);
    const created = createFollowUpJob({ rootDir: f.rootDir, jobId: f.job.jobId,
      repo: f.job.repo, prNumber: 7, branch: 'synthetic/fix', builderTag: null,
      reviewerModel: 'gemini', reviewBody: '## Blocking issues\n- Synthetic finding\n\n## Verdict\nRequest changes',
      createdAt: AT });
    assert.ok(created);
    const lines = [];
    const result = await consumeNextFollowUpJob({ rootDir: f.rootDir, promptTemplate: 'synthetic',
      ensureWorkerRegistryReadyImpl: async () => {}, now: () => AT,
      resolvePRLifecycleImpl: async () => ({ prState: 'open' }),
      readBuilderEvidenceImpl: async () => evidence,
      resolveRemediationWorkerClassImpl: async () => assert.fail('must stop before routing'),
      spawnImpl: () => assert.fail('must never spawn'),
      log: { ...quiet, error: line => lines.push(line) } });
    assert.equal(result.consumed, false);
    assert.equal(result.job.status, 'stopped');
    assert.equal(result.job.remediationWorker.state, 'never-spawned');
    assert.equal(result.job.remediationPlan.currentRound, 1, 'claim allocates its existing round');
    assert.equal(result.job.remediationPlan.publishedRoundsForPR, 0);
    assert.ok(isRetriggerableStoppedFollowUpJob(result.job));
    assert.equal(result.job.remediationPlan.stop.builderAuthorshipEscalation.owner, 'adversarial-review operator');
    assert.match(result.reason, /Owner: adversarial-review operator/);
    assert.match(lines[0], /Next action: Escalate/);
    assert.equal(JSON.parse(readFileSync(result.jobPath)).status, 'stopped');
  });
}
