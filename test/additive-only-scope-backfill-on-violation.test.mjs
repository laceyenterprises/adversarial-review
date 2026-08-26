/** The reviewer must not brand a PR with a contract it has already failed.
 *
 * On 2026-08-25 agent-os#5879, #5883 and #5906 each stopped dead for hours with
 * the same watcher line, and each needed a manual operator label to clear:
 *
 *     [watcher] automated dispatch suppressed for laceyenterprises/agent-os#5879:
 *     scope-violation finding present
 *
 * `pr-class: additive-only` was applied to all three by `lacey-gemini-reviewer[bot]`
 * -- the reviewer's own `backfillAdditiveOnlyLabel`, not the dispatcher's
 * `pr_class_labeler.py`. All three were opened with `gh pr create`, which never
 * runs the dispatcher classifier at all.
 *
 * #5879 is the clearest case. Its branch was cut from a tree that still carried
 * three unmerged commits of the SPV build pack, so GitHub's
 * `pulls/5879/commits` (everything since the merge-base with main) began with
 * SOMEONE ELSE'S build-pack commit. `initialCommitWindow` takes `commits[0]`
 * verbatim, that commit is pure `projects/**` + post-merge-actions, so the PR
 * derived as additive-only on work it did not own. Its actual commit --
 * `modules/sentinel/**` and `docs/postmortems/SEV-*.md`, allowlisted by nothing --
 * landed in `laterCommits` and violated immediately.
 *
 * The violation and the brand were produced by the SAME evaluation: the label
 * POST at 05:32:38Z sits between the reviewer's `pr_head_state` read at 05:32:36Z
 * and its `review_post` at 05:32:40Z. The reviewer stamped a contract onto a PR
 * in the same breath as proving it violated.
 *
 * And the stamp is terminal, because the label is not advisory once written:
 * `additiveOnly` short-circuits on it and `commitsToScan` widens from
 * `laterCommits` to every commit. #5879 was rebased clean at 15:11 -- the foreign
 * commits gone, `commits[0]` now its own honest work, derivation false -- and it
 * STILL could not clear, because by then the label proved itself. It took
 * `operator-approved: scope-expand` from VirtualPaul at 15:12:52Z.
 *
 * The invariant these tests pin: brand only on a completed, clean scan.
 * Enforcement is untouched -- derivation still runs every tick and the finding
 * still fires. It just stops being permanent.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ADDITIVE_ONLY_LABEL,
  SCOPE_EXPAND_LABEL,
  evaluateAdditiveOnlyScope,
  resolveAdditiveOnlyScopeReview,
} from '../src/additive-only-scope.mjs';

const PACK_YAML = 'modules/worker-pool/post-merge-actions/sentinel-probe-vision-standup.yaml';

function scope({ commits, labels = [], timeline = [], currentHeadSha = null }) {
  const filesByCommit = {};
  for (const [sha, entry] of Object.entries(commits)) {
    filesByCommit[sha] = Array.isArray(entry) ? { files: entry, truncated: false } : entry;
  }
  const shas = Object.keys(commits);
  return evaluateAdditiveOnlyScope({
    repo: 'laceyenterprises/agent-os',
    prNumber: 5879,
    labels,
    prAuthor: 'lacey-claude-agent',
    currentHeadSha: currentHeadSha || shas.at(-1),
    commits: shas.map((sha) => ({ sha })),
    filesByCommit,
    timeline,
  });
}

test('agent-os#5879: a stacked branch derives on a foreign commit and is not branded for it', () => {
  const result = scope({
    commits: {
      // Not this PR's work. The SPV pack, still open as its own PR, merely sits
      // between main and this branch.
      '2e704fcbb2': [
        { filename: 'projects/sentinel-probe-vision/SPEC.md', status: 'added' },
        { filename: PACK_YAML, status: 'added' },
      ],
      // #5879's own and only commit.
      'a46a56c56a': [
        { filename: 'docs/INDEX.md', status: 'modified' },
        {
          filename: 'docs/postmortems/SEV-hammer-stranded-by-non-retryable-progress-class-2026-08-25.md',
          status: 'added',
        },
        { filename: 'modules/sentinel/lib/python/sentinel/pipeline_stability_observer.py', status: 'modified' },
        { filename: 'modules/sentinel/test/test_hammer_stranded_pr_probe.py', status: 'added' },
      ],
    },
  });

  // Enforcement is unchanged: the finding still fires, and still names the four
  // files the live reviewer named.
  assert.equal(result.derivedAdditiveOnly, true);
  assert.equal(result.finding?.kind, 'scope-violation');
  assert.deepEqual(result.finding?.violating_files, [
    'docs/INDEX.md',
    'docs/postmortems/SEV-hammer-stranded-by-non-retryable-progress-class-2026-08-25.md',
    'modules/sentinel/lib/python/sentinel/pipeline_stability_observer.py',
    'modules/sentinel/test/test_hammer_stranded_pr_probe.py',
  ]);

  // But the PR is not branded with a class it has just been shown to violate.
  assert.equal(result.backfillNeeded, false);
});

test('agent-os#5906: an ordinary fix whose first commit happens to be allowlisted is not branded', () => {
  const result = scope({
    commits: {
      '39e2aef6f1': [{ filename: PACK_YAML, status: 'modified' }],
      '3b46c59756': [
        { filename: PACK_YAML, status: 'modified' },
        { filename: 'modules/worker-pool/worker-pool-walkthrough.md', status: 'modified' },
      ],
    },
  });

  assert.equal(result.derivedAdditiveOnly, true);
  assert.deepEqual(result.finding?.violating_files, ['modules/worker-pool/worker-pool-walkthrough.md']);
  assert.equal(result.backfillNeeded, false);
});

test('the brand survives for a PR that actually stayed in scope', () => {
  const result = scope({
    commits: {
      'dce04d928b': [
        { filename: 'projects/argus-security-route/SPEC.md', status: 'added' },
        { filename: 'projects/argus-security-route/plan.json', status: 'added' },
      ],
      'd6551ce59f': [{ filename: 'projects/argus-security-route/plan.json', status: 'modified' }],
    },
  });

  assert.equal(result.derivedAdditiveOnly, true);
  assert.equal(result.finding, null);
  assert.equal(result.backfillNeeded, true);
});

test('an unreadable commit is inconclusive, and inconclusive is not proof of scope', () => {
  const result = scope({
    commits: {
      'initial': [{ filename: 'projects/pack/plan.json', status: 'added' }],
      'huge': { files: [{ filename: 'projects/pack/plan.json', status: 'modified' }], truncated: true },
    },
  });

  assert.equal(result.finding?.file_list_truncated, true);
  assert.equal(result.backfillNeeded, false);
});

test('an operator scope-expand override does not get converted into a permanent brand', () => {
  const result = scope({
    commits: {
      'initial': [{ filename: 'projects/pack/plan.json', status: 'added' }],
      'later': [{ filename: 'modules/sentinel/lib/python/sentinel/watcher.py', status: 'modified' }],
    },
    labels: [{ name: SCOPE_EXPAND_LABEL }],
    currentHeadSha: 'later',
    timeline: [
      { event: 'committed', sha: 'later' },
      { event: 'labeled', label: { name: SCOPE_EXPAND_LABEL }, actor: { login: 'VirtualPaul' } },
    ],
  });

  assert.equal(result.overrideActive, true);
  assert.equal(result.finding, null);
  // The override is bound to `later`; the label would not be. Branding here
  // outlives the approval that licensed it.
  assert.equal(result.backfillNeeded, false);
});

test('resolver issues no label write on the evaluation that produced the finding', async () => {
  const calls = [];
  const result = await resolveAdditiveOnlyScopeReview({
    repo: 'laceyenterprises/agent-os',
    prNumber: 5879,
    snapshot: {
      prCreatedAt: '2026-08-25T05:26:14.000Z',
      prAuthor: 'lacey-claude-agent',
      currentHeadSha: 'a46a56c56a',
      labels: [],
      commits: [{ sha: '2e704fcbb2' }, { sha: 'a46a56c56a' }],
      filesByCommit: {
        '2e704fcbb2': [{ filename: 'projects/sentinel-probe-vision/SPEC.md', status: 'added' }],
        'a46a56c56a': [
          { filename: 'modules/sentinel/lib/python/sentinel/pipeline_stability_observer.py', status: 'modified' },
        ],
      },
      timeline: [],
    },
    backfillLabelImpl: async (args) => {
      calls.push(args);
      return { attempted: true, added: true };
    },
  });

  assert.equal(result.finding?.kind, 'scope-violation');
  assert.equal(calls.length, 0);
  assert.equal(result.backfill, undefined);
});

test('a genuinely labeled PR is still enforced across every commit', () => {
  const result = scope({
    labels: [{ name: ADDITIVE_ONLY_LABEL }],
    commits: {
      'initial': [{ filename: 'src/escape.mjs', status: 'added' }],
      'later': [{ filename: 'projects/pack/plan.json', status: 'modified' }],
    },
  });

  assert.equal(result.additiveOnly, true);
  assert.deepEqual(result.finding?.violating_files, ['src/escape.mjs']);
});
