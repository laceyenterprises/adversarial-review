// A PR that exhausts its remediation budget lands in
// `success (remediation-stopped)` with operatorDecisionRequired=true. AMA then
// refuses it (correctly -- findings still stand) and no further remediation runs
// (correctly -- the budget is spent). Before this, nobody was told: the state was
// a console.log and nothing else, so the PR sat until a human happened to look.
// Observed on agent-os#6156, stuck from 10:30Z until an operator asked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { processReviewSubject } from '../src/pollonce-phases.mjs';
import { getFollowUpJobDir, writeFollowUpJob } from '../src/follow-up-jobs.mjs';
import {
  hasOperatorDecisionRequiredAlerted,
  markOperatorDecisionRequiredAlerted,
  readCascadeState,
} from '../src/reviewer-cascade.mjs';

function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'odr-'));
  try { return fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

async function withRootAsync(fn) {
  const root = mkdtempSync(join(tmpdir(), 'odr-'));
  try { return await fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const REPO = 'o/r';

function writeStoppedRequestChangesJob(root) {
  const dir = getFollowUpJobDir(root, 'stopped');
  mkdirSync(dir, { recursive: true });
  writeFollowUpJob(join(dir, 'o-r-pr-1.json'), {
    schemaVersion: 1,
    kind: 'adversarial-review-follow-up',
    status: 'stopped',
    jobId: 'o-r-pr-1',
    createdAt: '2026-09-04T12:00:00.000Z',
    stoppedAt: '2026-09-04T12:10:00.000Z',
    repo: REPO,
    prNumber: 1,
    domainId: 'github-pr',
    subjectExternalId: `${REPO}#1`,
    revisionRef: HEAD,
    reviewerModel: 'gemini',
    reviewBody: '## Summary\nStill blocked.\n\n## Verdict\nRequest changes',
    remediationPlan: {
      currentRound: 3,
      maxRounds: 3,
      stop: { code: 'max-rounds-reached' },
    },
    remediationWorker: { state: 'completed' },
  });
}

async function runMergedPostedSubject(root, { deliverAlertFn, errors = [] } = {}) {
  writeStoppedRequestChangesJob(root);
  await processReviewSubject({
    subject: {
      title: '[codex] operator decision fixture',
      labels: [],
      headSha: HEAD,
      ref: { revisionRef: HEAD, subjectExternalId: `${REPO}#1` },
    },
    prNumber: 1,
    current: {
      review_status: 'posted',
      pr_state: 'merged',
      reviewer_head_sha: HEAD,
      review_attempts: 1,
      posted_at: '2026-09-04T12:00:00.000Z',
      failed_at: null,
      merged_at: '2026-09-04T12:15:00.000Z',
    },
  }, {
    operatorSurface: { extractLinearTicketId: () => null },
    watcherDrain: { active: false },
    postedReviewHandlers: [],
    domainId: 'github-pr',
    repoPath: REPO,
    currentRepoPRs: [],
    activeMergeAgentPRs: [],
    ROOT: root,
    execFileAsync: async () => ({ stdout: '', stderr: '' }),
    WATCHER_PRIMARY_DOMAIN_ID: 'github-pr',
    deliverAlertFn,
    adversarialGateProvider: {
      async gate(_subject, revisionRef, decision) {
        return {
          gated: true,
          providerId: 'fixture-gate',
          revisionRef,
          publish: { posted: true, reason: 'fixture', decision },
        };
      },
    },
    shouldDeferReviewForActiveFollowUp: () => ({ defer: false }),
    handlePollError: () => {},
  });
  return errors;
}

test('alerts once for a given head', () => {
  withRoot((root) => {
    const args = { repo: 'o/r', prNumber: 1, headSha: 'aaa', reason: 'remediation-stopped' };
    assert.equal(markOperatorDecisionRequiredAlerted(root, args).marked, true,
      'first observation of a head must alert');
    assert.equal(markOperatorDecisionRequiredAlerted(root, args).marked, false,
      'repeat polls on the same head must not re-page');
    assert.equal(markOperatorDecisionRequiredAlerted(root, args).marked, false);
  });
});

test('a new head re-arms the alert', () => {
  withRoot((root) => {
    const base = { repo: 'o/r', prNumber: 1, reason: 'remediation-stopped' };
    assert.equal(markOperatorDecisionRequiredAlerted(root, { ...base, headSha: 'aaa' }).marked, true);
    assert.equal(markOperatorDecisionRequiredAlerted(root, { ...base, headSha: 'aaa' }).marked, false);
    // A push is a fresh chance to converge, so the operator is told again.
    assert.equal(markOperatorDecisionRequiredAlerted(root, { ...base, headSha: 'bbb' }).marked, true,
      'a new head must re-arm; otherwise one alert covers the PR forever');
  });
});

test('missing head sha is a valid dedupe key', () => {
  withRoot((root) => {
    const base = { repo: 'o/r', prNumber: 1, reason: 'remediation-stopped' };
    assert.equal(hasOperatorDecisionRequiredAlerted(root, base), false);
    assert.equal(markOperatorDecisionRequiredAlerted(root, base).marked, true);
    assert.equal(readCascadeState(root, { repo: 'o/r', prNumber: 1 }).operatorDecisionAlertedHeadSha, null);
    assert.equal(hasOperatorDecisionRequiredAlerted(root, base), true);
    assert.equal(markOperatorDecisionRequiredAlerted(root, base).marked, false,
      'repeat polls without a head sha must not re-page');
    assert.equal(markOperatorDecisionRequiredAlerted(root, { ...base, headSha: 'bbb' }).marked, true,
      'a later observed head still re-arms the alert');
  });
});

test('per-PR isolation', () => {
  withRoot((root) => {
    const a = { repo: 'o/r', prNumber: 1, headSha: 'aaa' };
    const b = { repo: 'o/r', prNumber: 2, headSha: 'aaa' };
    assert.equal(markOperatorDecisionRequiredAlerted(root, a).marked, true);
    assert.equal(markOperatorDecisionRequiredAlerted(root, b).marked, true,
      'a different PR must alert on its own');
  });
});

test('the mark records why, for the operator reading state later', () => {
  withRoot((root) => {
    const res = markOperatorDecisionRequiredAlerted(root, {
      repo: 'o/r', prNumber: 3, headSha: 'ccc', reason: 'remediation-stopped',
    });
    assert.equal(res.state.operatorDecisionAlert.reason, 'remediation-stopped');
    assert.equal(res.state.operatorDecisionAlertedHeadSha, 'ccc');
    assert.ok(res.state.operatorDecisionAlertedAt);
  });
});

test('the watcher wires the alert to the gate decision', async () => {
  await withRootAsync(async (root) => {
    const alerts = [];
    await runMergedPostedSubject(root, {
      deliverAlertFn: async (text, meta) => { alerts.push({ text, meta }); },
    });

    assert.equal(alerts.length, 1);
    assert.match(alerts[0].text, /operator decision/);
    assert.equal(alerts[0].meta.event, 'adversarial_review.operator_decision_required');
    assert.equal(alerts[0].meta.payload.head_sha, HEAD);
    assert.equal(
      readCascadeState(root, { repo: REPO, prNumber: 1 }).operatorDecisionAlertedHeadSha,
      HEAD,
    );
  });
});

test('watcher retries operator-decision alert after delivery failure', async () => {
  await withRootAsync(async (root) => {
    await runMergedPostedSubject(root, {
      deliverAlertFn: async () => { throw new Error('alert bus unavailable'); },
    });
    assert.equal(
      readCascadeState(root, { repo: REPO, prNumber: 1 })?.operatorDecisionAlertedHeadSha,
      undefined,
      'failed delivery must not be recorded as delivered',
    );

    const alerts = [];
    await runMergedPostedSubject(root, {
      deliverAlertFn: async (text, meta) => { alerts.push({ text, meta }); },
    });
    assert.equal(alerts.length, 1, 'the next poll can retry after the alert bus recovers');
    assert.equal(
      readCascadeState(root, { repo: REPO, prNumber: 1 }).operatorDecisionAlertedHeadSha,
      HEAD,
    );
  });
});
