import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const initText = readFileSync('scripts/init-adversarial-review-labels.sh', 'utf8');
const fastText = readFileSync('scripts/create-fast-merge-labels.sh', 'utf8');
const runbookText = readFileSync('docs/RUNBOOK-new-repo-standup.md', 'utf8');

describe('label initializer contract', () => {
  it('keeps the Agent OS PR-control subset exact inside the adversarial-review superset', () => {
    const labels = parsePipeLabels(initText);
    const expectedPrControl = new Map([
      ['retrigger-remediation', ['D4C5F9', 'Operator requests one more adversarial remediation/re-review cycle.']],
      ['retrigger-review', ['C5E1F9', 'Watcher signal: re-run adversarial review on current HEAD (applied by merge-agent post-push).']],
      ['merge-agent-requested', ['5319E7', 'Operator requests merge-agent clean/rebase/validate/merge.']],
      ['merge-agent-dispatched', ['BFD4F2', 'Watcher marker: merge-agent in flight. Label-add and cancel-on-merge retries are durable.']],
      ['merge-agent-recovery-in-flight', ['C2E0F4', 'Merge-agent marker: failure-recovery worker in flight. Suppresses phantom-handoff grace.']],
      ['operator-approved', ['0E8A16', 'Operator accepts latest review; merge-agent may run if hard gates pass.']],
      ['merge-on-comment-only', ['6F42C1', 'Operator escape valve: Comment-only reviews may merge even with non-blocking findings.']],
      ['address-all-findings', ['0052CC', 'Operator strict-mode request: Comment-only reviews with non-blocking findings must remediate.']],
      ['merge-agent-skip', ['E55300', 'Block merge-agent auto-dispatch for this PR.']],
      ['do-not-merge', ['B60205', 'Hard block for merge and merge-agent automation.']],
      ['no-auto-merge', ['FBCA04', 'Block auto-merge daemon; other PR automation may continue.']],
      ['merge-agent-stuck', ['D93F0B', 'Merge-agent output: operator attention required before retry.']],
      ['stale-drift', ['C5DEF5', 'PR drift helper flagged stale branch; refresh before more review.']],
      ['pr-class: additive-only', ['B7E4C7', 'Initial PR diff was additive-only; scope expansion requires approval.']],
      ['operator-approved: scope-expand', ['0E8A16', 'Current-head approval for additive-only PR scope expansion.']],
      ['reviewer-cycle-cap-reached', ['F9D0C4', 'Reviewer cycle cap reached; operator must approve, merge-agent, or redesign.']],
      ['paused-for-redesign', ['8B949E', 'Operator paused the PR for redesign after cycle-cap escalation.']],
      ['operator-approved: advisory-only-review', ['0E8A16', 'Current-head approval for advisory-only review without remediation dispatch.']],
    ]);

    for (const [name, [color, description]] of expectedPrControl) {
      assert.deepEqual(labels.get(name), { color, description }, `${name} must match Agent OS PR-control label contract`);
    }
  });

  it('keeps the fast-merge helper aligned with the adversarial-review superset', () => {
    const labels = parsePipeLabels(initText);
    const fastLabels = parsePipeLabels(fastText);
    for (const [name, value] of fastLabels) {
      assert.deepEqual(value, labels.get(name), `${name} must match init-adversarial-review-labels.sh`);
    }
  });

  it('guards GitHub label API limits and verification truncation', () => {
    const labels = parsePipeLabels(initText);
    for (const [name, { description }] of labels) {
      assert.ok(description.length <= 100, `${name} description exceeds GitHub limit`);
    }
    assert.match(initText, /description_length\(\)/);
    assert.match(initText, /sed 's\/\^\/    gh: \/'/);
    assert.match(runbookText, /gh label list --repo laceyenterprises\/<repo> --limit 1000 --json name/);
  });
});

function parsePipeLabels(text) {
  const labels = new Map();
  const pattern = /^\s*"([^"|]+)\|([^"|]*)\|([A-Fa-f0-9]{6})"/gm;
  for (const match of text.matchAll(pattern)) {
    labels.set(match[1], { description: match[2], color: match[3].toUpperCase() });
  }
  return labels;
}
