import './helpers/rate-limit-state-isolation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFollowUpJob } from '../src/follow-up-jobs.mjs';
import { buildRemediationPrompt } from '../src/remediation-prompt-builder.mjs';

function makeReviewerJob(overrides = {}) {
  return { ...buildFollowUpJob({
    repo: 'fixture/repo', prNumber: 42, reviewerModel: 'claude-opus-5-5',
    reviewBody: '## Verdict\nRequest changes',
  }), ...overrides };
}

test('buildFollowUpJob persists exact legacy reviewer roles without replacing explicit evidence', () => {
  const input = { repo: 'fixture/repo', prNumber: 42, reviewBody: 'Request changes' };
  for (const [reviewerModel, reviewerRole] of [
    ['claude-opus-5-5', 'claude-reviewer'],
    ['claude', 'claude-reviewer'],
    ['claude-code', 'claude-reviewer'],
    ['codex', 'codex-reviewer'],
    ['gemini', 'gemini-reviewer'],
    ['grok', 'grok-reviewer'],
  ]) {
    const persisted = JSON.parse(JSON.stringify(buildFollowUpJob({ ...input, reviewerModel })));
    assert.equal(persisted.reviewerRole, reviewerRole);
    assert.equal(persisted.reviewerModel, reviewerModel);
  }
  for (const reviewerModel of ['claude-opus-5-5-unknown', undefined]) {
    assert.equal(Object.hasOwn(buildFollowUpJob({ ...input, reviewerModel }), 'reviewerRole'), false);
  }
  for (const reviewerRole of [null, '', 'unknown-reviewer', 'codex-reviewer']) {
    assert.equal(buildFollowUpJob({
      ...input, reviewerModel: 'claude-opus-5-5', reviewerRole,
    }).reviewerRole, reviewerRole);
  }
});

test('buildRemediationPrompt emits only non-empty string reviewer roles for publication workers', () => {
  for (const reviewerRole of [undefined, null, '', ' \t ', false, 42]) {
    const prompt = buildRemediationPrompt(makeReviewerJob({ reviewerRole }), {
      template: 'You are a remediation worker.',
      hqRoot: process.env.HQ_ROOT,
      launchRequestId: 'reviewer-role-test',
      publicationWorkerClass: 'codex',
    });
    assert.match(prompt, /--worker-class 'codex'/);
    assert.doesNotMatch(prompt, /--reviewer-role/);
  }
  const prompt = buildRemediationPrompt(makeReviewerJob({ reviewerRole: 'claude-reviewer' }), {
    template: 'You are a remediation worker.',
    hqRoot: process.env.HQ_ROOT,
    launchRequestId: 'reviewer-role-test',
    publicationWorkerClass: 'codex',
  });
  assert.match(prompt, /--reviewer-role 'claude-reviewer'/);
  const withoutWorker = buildRemediationPrompt(makeReviewerJob({ reviewerRole: 'claude-reviewer' }), {
    template: 'You are a remediation worker.',
    hqRoot: process.env.HQ_ROOT,
    launchRequestId: 'reviewer-role-test',
  });
  assert.doesNotMatch(withoutWorker, /--reviewer-role/);
});

