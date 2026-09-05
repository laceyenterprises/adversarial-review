// TQL-01 — required check contexts: absent is pending, never green.
//
// The regression these tests pin is the one the 2026-09-03 system audit found
// live: with the `Unit Tests` and `Operational CI Gauntlet` workflows disabled
// on 2026-08-29, their contexts stopped appearing in the rollup entirely, and
// the lint-and-guards remainder classified SUCCESS. Neither fail-closed rule in
// the merge gate could see it — `summarizeChecksConclusion()` only fails closed
// on a wholly EMPTY rollup, and `requiredChecksGreen()` only on an empty
// required-check array. A check that never runs must read "has not reported
// yet", not "nothing to see here".
//
// Ordered by the ticket's test sentence: absent ⇒ not green; pending ⇒ not
// green; failed ⇒ the failure state; all present and successful ⇒ green; empty
// list ⇒ byte-for-byte today's behavior; adversarial-own contexts still
// excluded.

import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { summarizeChecksConclusion } from '../src/checks-summary.mjs';
import { loadConfig } from '../src/config-loader.mjs';
import {
  missingRequiredCheckContexts,
  parseRequiredCheckContextEntry,
  selectRequiredCheckContexts,
} from '../src/required-check-contexts.mjs';
import {
  evaluateMergeEligibility,
  __testables__ as MERGE_ELIGIBILITY_TESTABLES,
} from '../src/ama/merge-eligibility.mjs';

const { requiredChecksGreen } = MERGE_ELIGIBILITY_TESTABLES;

// Empty env: the self-gate context resolver reads ADV_GATE_STATUS_CONTEXT, and
// these cases must not depend on the host's value.
const ENV = {};

const AGENT_OS = 'laceyenterprises/agent-os';
const ADVERSARIAL_REVIEW = 'laceyenterprises/adversarial-review';

// The seed list shipped in this module's `config.yaml`, verified 2026-09-05
// against the head rollup of the 25 most recently merged PRs in each repo AND
// against each workflow's trigger (no `paths` filter — a path-skipped check
// emits no check run, so requiring one would hang the PRs it skips forever).
const SEED_CONTEXTS = Object.freeze([
  'laceyenterprises/agent-os:release-freeze-gate',
  'laceyenterprises/adversarial-review:npm test (Node 20)',
  'laceyenterprises/adversarial-review:npm test (Node 22)',
]);

function checkRun(name, conclusion = 'SUCCESS', status = 'COMPLETED') {
  return { __typename: 'CheckRun', name, status, conclusion };
}

function statusContext(context, state = 'SUCCESS') {
  return { __typename: 'StatusContext', context, state };
}

// ── The registry: which contexts apply to which PR ───────────────────────────

test('a bare entry applies to every repo; a repo-scoped entry only to its repo', () => {
  const configured = ['local-battery', `${AGENT_OS}:repo-guards`];

  assert.deepEqual(
    selectRequiredCheckContexts(configured, { repo: AGENT_OS, env: ENV }),
    ['local-battery', 'repo-guards'],
  );
  assert.deepEqual(
    selectRequiredCheckContexts(configured, { repo: ADVERSARIAL_REVIEW, env: ENV }),
    ['local-battery'],
  );
});

test('an unknown repo applies EVERY entry (fail closed, never silently unenforced)', () => {
  // A call site that forgets to plumb the repo over-requires — PRs park with a
  // visible `ci-not-green` — rather than dropping the requirement silently.
  const all = ['release-freeze-gate', 'npm test (node 20)', 'npm test (node 22)'];
  assert.deepEqual(selectRequiredCheckContexts(SEED_CONTEXTS, { repo: null, env: ENV }), all);
  assert.deepEqual(selectRequiredCheckContexts(SEED_CONTEXTS, { repo: '   ', env: ENV }), all);
});

test('entries normalize: case, blanks, duplicates, `.git` and long repo paths', () => {
  assert.deepEqual(
    selectRequiredCheckContexts(
      ['  Repo-Guards  ', '', null, 'repo-guards', `${AGENT_OS}:Repo-Guards`],
      { repo: 'git@github.com:laceyenterprises/agent-os.git', env: ENV },
    ),
    ['repo-guards'],
  );
});

test('a check name containing a colon is not mistaken for a repo scope', () => {
  // Only an `owner/repo`-shaped prefix separates; `build: linux` is one name.
  assert.deepEqual(parseRequiredCheckContextEntry('build: linux'), {
    repo: null,
    context: 'build: linux',
  });
  assert.deepEqual(
    parseRequiredCheckContextEntry(`${ADVERSARIAL_REVIEW}:npm test (Node 20)`),
    { repo: ADVERSARIAL_REVIEW, context: 'npm test (node 20)' },
  );
});

test('missingRequiredCheckContexts matches CheckRun names and StatusContext contexts', () => {
  const rollup = [checkRun('repo-guards'), statusContext('ci/legacy')];
  assert.deepEqual(
    missingRequiredCheckContexts(rollup, ['repo-guards', 'ci/legacy', 'release-freeze-gate']),
    ['release-freeze-gate'],
  );
  // No required contexts ⇒ nothing can be missing, whatever the rollup is.
  assert.deepEqual(missingRequiredCheckContexts(rollup, []), []);
  assert.deepEqual(missingRequiredCheckContexts(undefined, ['repo-guards']), ['repo-guards']);
});

// ── summarizeChecksConclusion ────────────────────────────────────────────────

test('summarizeChecksConclusion: an ABSENT required context is PENDING, never green', () => {
  // The live 2026-08-29 shape: guards reported and passed, the test workflow
  // never ran, so its context is simply not in the rollup.
  const rollup = [checkRun('repo-guards'), checkRun('release-freeze-gate')];

  assert.equal(
    summarizeChecksConclusion(rollup, {
      env: ENV,
      repo: AGENT_OS,
      requiredCheckContexts: [...SEED_CONTEXTS, `${AGENT_OS}:unit-tests`],
    }),
    'PENDING',
  );
  // Same rollup, no required list: the pre-TQL-01 read.
  assert.equal(summarizeChecksConclusion(rollup, { env: ENV }), 'SUCCESS');
});

test('summarizeChecksConclusion: a required context that is PENDING is PENDING', () => {
  const rollup = [
    checkRun('repo-guards'),
    checkRun('release-freeze-gate', null, 'IN_PROGRESS'),
  ];
  assert.equal(
    summarizeChecksConclusion(rollup, {
      env: ENV,
      repo: AGENT_OS,
      requiredCheckContexts: SEED_CONTEXTS,
    }),
    'PENDING',
  );
});

test('summarizeChecksConclusion: a FAILED check wins over an absent required context', () => {
  // A red rollup must keep reporting its failure state — the operator needs to
  // see FAILURE, not a pending read that hides it.
  const rollup = [
    checkRun('repo-guards', 'FAILURE'),
    checkRun('release-freeze-gate'),
  ];
  assert.equal(
    summarizeChecksConclusion(rollup, {
      env: ENV,
      repo: AGENT_OS,
      requiredCheckContexts: [...SEED_CONTEXTS, `${AGENT_OS}:unit-tests`],
    }),
    'FAILURE',
  );
});

test('summarizeChecksConclusion: all required contexts present and successful ⇒ SUCCESS', () => {
  const rollup = [
    checkRun('repo-guards'),
    checkRun('release-freeze-gate'),
    checkRun('Ruff lint and format baseline'),
  ];
  assert.equal(
    summarizeChecksConclusion(rollup, {
      env: ENV,
      repo: AGENT_OS,
      requiredCheckContexts: SEED_CONTEXTS,
    }),
    'SUCCESS',
  );
  // The adversarial-review half of the same seed list, on its own repo — the
  // entries scoped to agent-os do not apply here.
  assert.equal(
    summarizeChecksConclusion(
      [checkRun('npm test (Node 20)'), checkRun('npm test (Node 22)')],
      { env: ENV, repo: ADVERSARIAL_REVIEW, requiredCheckContexts: SEED_CONTEXTS },
    ),
    'SUCCESS',
  );
});

test('summarizeChecksConclusion: an EMPTY list is byte-for-byte the pre-TQL-01 behavior', () => {
  const rollups = [
    [checkRun('repo-guards')],
    [checkRun('repo-guards'), checkRun('unit-tests', 'FAILURE')],
    [checkRun('repo-guards', null, 'QUEUED')],
    [statusContext('agent-os/adversarial-gate')],
    [],
  ];
  const expected = ['SUCCESS', 'FAILURE', 'PENDING', null, null];

  rollups.forEach((rollup, index) => {
    const baseline = summarizeChecksConclusion(rollup, { env: ENV });
    assert.equal(baseline, expected[index]);
    for (const configured of [[], null, undefined]) {
      assert.equal(
        summarizeChecksConclusion(rollup, {
          env: ENV,
          repo: AGENT_OS,
          requiredCheckContexts: configured,
        }),
        baseline,
      );
    }
  });
  // Missing / malformed rollups keep failing closed as `null` regardless.
  assert.equal(
    summarizeChecksConclusion(undefined, { env: ENV, requiredCheckContexts: SEED_CONTEXTS }),
    null,
  );
  assert.equal(
    summarizeChecksConclusion({}, { env: ENV, requiredCheckContexts: SEED_CONTEXTS }),
    null,
  );
});

test('adversarial-own contexts stay excluded from the rollup AND from the required list', () => {
  // (a) The self-gate StatusContext is still filtered out of the rollup: a PR
  //     whose ONLY check is the pipeline's own gate reads `null`, not SUCCESS.
  assert.equal(
    summarizeChecksConclusion([statusContext('agent-os/adversarial-gate')], {
      env: ENV,
      repo: AGENT_OS,
      requiredCheckContexts: SEED_CONTEXTS,
    }),
    null,
  );

  // (b) Listing a self-gate context cannot wedge the gate. It is excluded from
  //     the rollup by construction, so requiring it would be unsatisfiable
  //     forever; it is dropped from the required list instead.
  assert.deepEqual(
    selectRequiredCheckContexts(['agent-os/adversarial-gate', 'repo-guards'], {
      repo: AGENT_OS,
      env: ENV,
    }),
    ['repo-guards'],
  );
  assert.equal(
    summarizeChecksConclusion([checkRun('repo-guards'), statusContext('agent-os/adversarial-gate')], {
      env: ENV,
      repo: AGENT_OS,
      requiredCheckContexts: ['agent-os/adversarial-gate', `${AGENT_OS}:repo-guards`],
    }),
    'SUCCESS',
  );

  // The operator-configured gate context is excluded too, not just the default.
  assert.deepEqual(
    selectRequiredCheckContexts(['custom/gate', 'repo-guards'], {
      repo: AGENT_OS,
      env: { ADV_GATE_STATUS_CONTEXT: 'custom/gate' },
    }),
    ['repo-guards'],
  );
});

// ── requiredChecksGreen / evaluateMergeEligibility ───────────────────────────

test('requiredChecksGreen: absent ⇒ false, pending ⇒ false, present ⇒ true', () => {
  const green = [checkRun('repo-guards'), checkRun('release-freeze-gate')];

  assert.equal(requiredChecksGreen(green, ['repo-guards', 'unit-tests']), false);
  assert.equal(
    requiredChecksGreen(
      [checkRun('repo-guards'), checkRun('unit-tests', null, 'IN_PROGRESS')],
      ['repo-guards', 'unit-tests'],
    ),
    false,
  );
  assert.equal(requiredChecksGreen(green, ['repo-guards', 'release-freeze-gate']), true);
  // Empty required list: unchanged from the pre-TQL-01 predicate.
  assert.equal(requiredChecksGreen(green, []), true);
  assert.equal(requiredChecksGreen(green), true);
  assert.equal(requiredChecksGreen([]), false);
});

test('requiredChecksGreen: a boolean cannot prove presence, so it fails closed', () => {
  assert.equal(requiredChecksGreen(true), true);
  assert.equal(requiredChecksGreen(true, ['repo-guards']), false);
  assert.equal(requiredChecksGreen(false, []), false);
});

test('evaluateMergeEligibility: an absent required context raises ci-not-green', () => {
  const HEAD = 'd1c064df0f16dff999adeb51484fcd0a8a0747b6';
  const state = (overrides = {}) => ({
    verdict: 'settled-success',
    requiredChecks: [checkRun('repo-guards'), checkRun('release-freeze-gate')],
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    prState: 'OPEN',
    branchProtectionRequired: true,
    requiredGateContext: 'agent-os/adversarial-gate',
    branchProtectionRequiredContexts: ['agent-os/adversarial-gate'],
    candidateHead: HEAD,
    validatedHead: HEAD,
    leaseHeld: true,
    repo: AGENT_OS,
    env: ENV,
    ...overrides,
  });

  // The mockup in the SPEC: repo-guards SUCCESS, release-freeze-gate SUCCESS,
  // unit-tests ABSENT → not eligible, `ci-not-green`.
  assert.deepEqual(
    evaluateMergeEligibility(
      state({ requiredCheckContexts: [...SEED_CONTEXTS, `${AGENT_OS}:unit-tests`] }),
    ),
    { eligible: false, reasons: ['ci-not-green'] },
  );

  // Present ⇒ eligible.
  assert.deepEqual(
    evaluateMergeEligibility(state({ requiredCheckContexts: SEED_CONTEXTS })),
    { eligible: true, reasons: [] },
  );

  // Scoped to another repo ⇒ does not apply.
  assert.deepEqual(
    evaluateMergeEligibility(
      state({ requiredCheckContexts: [`${ADVERSARIAL_REVIEW}:npm test (Node 20)`] }),
    ),
    { eligible: true, reasons: [] },
  );

  // Unknown repo ⇒ every entry applies (fail closed).
  assert.deepEqual(
    evaluateMergeEligibility(
      state({ repo: undefined, requiredCheckContexts: SEED_CONTEXTS }),
    ),
    { eligible: false, reasons: ['ci-not-green'] },
  );

  // Empty list ⇒ unchanged.
  assert.deepEqual(
    evaluateMergeEligibility(state({ requiredCheckContexts: [] })),
    { eligible: true, reasons: [] },
  );
});

test('the shipped config.yaml seed is exactly the list these tests exercise', () => {
  // Keeps the fixture, the shipped default, and the runbook from drifting: a
  // name added to `config.yaml` without the live-rollup + no-path-filter check
  // this file documents is the way this gate wedges a repo.
  const cfg = loadConfig({
    topPath: join(tmpdir(), 'tql-01-no-such-top-config.yaml'),
    modulePaths: [fileURLToPath(new URL('../config.yaml', import.meta.url))],
    env: {},
  });
  assert.deepEqual(
    cfg.getMergeAuthorityConfig().requiredCheckContexts,
    [...SEED_CONTEXTS],
  );
});
