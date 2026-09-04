// A PR that exhausts its remediation budget lands in
// `success (remediation-stopped)` with operatorDecisionRequired=true. AMA then
// refuses it (correctly -- findings still stand) and no further remediation runs
// (correctly -- the budget is spent). Before this, nobody was told: the state was
// a console.log and nothing else, so the PR sat until a human happened to look.
// Observed on agent-os#6156, stuck from 10:30Z until an operator asked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { markOperatorDecisionRequiredAlerted } from '../src/reviewer-cascade.mjs';

function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'odr-'));
  try { return fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
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
  // Guard the wiring, not just the helper: a helper that exists while nothing
  // calls it is precisely the failure this change removes.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/pollonce-phases.mjs', import.meta.url), 'utf8');
  assert.match(src, /operatorDecisionRequired/, 'gate flag must be read');
  assert.match(src, /markOperatorDecisionRequiredAlerted\(/, 'mark must be called');
  assert.match(src, /adversarial_review\.operator_decision_required/, 'alert event must be emitted');
});
