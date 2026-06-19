import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildVocabularyFatigueFinding,
  emitVocabularyFatigueFindingForPR,
  handlePostedReviewRow,
} from '../src/watcher.mjs';

function loadConfigFor({ window = 5, minRepeats = 3 } = {}) {
  return {
    get(key, fallback) {
      if (key === 'agent_control.codex_runaway_guardrails.vocabulary_fatigue_window_commits') return window;
      if (key === 'agent_control.codex_runaway_guardrails.vocabulary_fatigue_min_repeats') return minRepeats;
      return fallback;
    },
  };
}

function captureLogger() {
  const lines = [];
  return {
    lines,
    logger: {
      info(line) {
        lines.push(String(line));
      },
      log() {},
      warn() {},
      error() {},
    },
  };
}

test('vocabulary fatigue emits when a stem reaches three repeats in five commits', () => {
  const finding = buildVocabularyFatigueFinding([
    '[codex] Harden',
    '[codex] Harden',
    '[codex] Harden',
    '[codex] Close',
    '[codex] Tighten',
  ]);

  assert.equal(finding.kind, 'remediation-vocabulary-fatigue');
  assert.equal(finding.severity, 'info');
  assert.equal(finding.blocking, false);
  assert.equal(finding.stem, 'harden');
  assert.equal(finding.count, 3);
  assert.equal(finding.window, 5);
});

test('vocabulary fatigue does not emit when commit verbs are diverse', () => {
  const finding = buildVocabularyFatigueFinding([
    '[codex] Add',
    '[codex] Refactor',
    '[codex] Test',
    '[codex] Document',
    '[codex] Fix',
  ]);

  assert.equal(finding, null);
});

test('vocabulary fatigue strips only ing and ed suffixes', () => {
  const finding = buildVocabularyFatigueFinding([
    '[codex] Hardening',
    '[codex] Hardened',
    '[codex] Harden',
    '[codex] Close',
    '[codex] Tighten',
  ]);

  assert.equal(finding.stem, 'harden');
  assert.equal(finding.count, 3);
});

test('vocabulary fatigue requires a full configured window', () => {
  const finding = buildVocabularyFatigueFinding([
    '[codex] Harden',
    '[codex] Harden',
    '[codex] Harden',
  ]);

  assert.equal(finding, null);
});

test('vocabulary fatigue resolves window and min repeats from CFG', async () => {
  const { lines, logger } = captureLogger();
  const finding = await emitVocabularyFatigueFindingForPR({
    repoPath: 'laceyenterprises/adversarial-review',
    prNumber: 8,
    logger,
    loadConfigImpl: () => loadConfigFor({ window: 4, minRepeats: 2 }),
    fetchCommitSubjectsImpl: async () => [
      '[codex] Add',
      '[codex] Harden',
      '[codex] Harden',
      '[codex] Close',
    ],
  });

  assert.equal(finding.stem, 'harden');
  assert.equal(finding.count, 2);
  assert.equal(finding.window, 4);
  assert.deepEqual(JSON.parse(lines[0]), finding);
});

test('vocabulary fatigue finding is informational and does not gate merge-agent dispatch', async () => {
  const { lines, logger } = captureLogger();
  let dispatched = false;

  await handlePostedReviewRow({
    rootDir: process.cwd(),
    repoPath: 'laceyenterprises/adversarial-review',
    prNumber: 8,
    existing: { review_status: 'posted', reviewer: 'codex', reviewer_head_sha: 'sha' },
    subjectRef: {
      domainId: 'code-pr',
      subjectExternalId: 'laceyenterprises/adversarial-review#8',
      revisionRef: 'sha',
    },
    currentRevisionRef: 'sha',
    labelNames: [],
    projectGateStatusSafe: async () => {},
    emitVocabularyFatigueFindingForPRImpl: async ({ logger: injectedLogger }) => {
      const finding = buildVocabularyFatigueFinding([
        '[codex] Harden',
        '[codex] Harden',
        '[codex] Harden',
        '[codex] Close',
        '[codex] Tighten',
      ]);
      injectedLogger.info(JSON.stringify(finding));
      return finding;
    },
    fetchMergeAgentCandidateImpl: async () => ({ headSha: 'sha', prState: 'open' }),
    buildMergeAgentDispatchJobImpl: () => ({
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 8,
      headSha: 'sha',
      blockingFindingCount: 0,
      blockingFindingState: 'known',
    }),
    resolveMergeAgentCoexistenceForWatcherImpl: async () => ({
      outcome: 'dispatch-merge-agent',
      coexistence: null,
      dispatchEnv: null,
    }),
    dispatchMergeAgentForPRImpl: async () => {
      dispatched = true;
      return { decision: 'dispatched' };
    },
    logger,
  });

  assert.equal(dispatched, true);
  const emitted = JSON.parse(lines[0]);
  assert.equal(emitted.kind, 'remediation-vocabulary-fatigue');
  assert.equal(emitted.blocking, false);
});
