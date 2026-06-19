import test from 'node:test';
import assert from 'node:assert/strict';

import {
  detectCommitVocabularyFatigue,
  resolveVocabularyFatigueConfig,
} from '../src/watcher.mjs';
import { pickMergeAgentDispatch } from '../src/follow-up-merge-agent.mjs';

test('commit vocabulary fatigue emits informational finding for repeated stem', () => {
  const finding = detectCommitVocabularyFatigue([
    '[codex] Harden',
    '[codex] Harden',
    '[codex] Harden',
    '[codex] Close',
    '[codex] Tighten',
  ], { windowCommits: 5, minRepeats: 3 });

  assert.equal(finding.kind, 'remediation-vocabulary-fatigue');
  assert.equal(finding.severity, 'info');
  assert.equal(finding.blocking, false);
  assert.equal(finding.stem, 'harden');
  assert.equal(finding.count, 3);
  assert.equal(finding.window, 5);
  assert.match(finding.detail, /The verb 'harden' appears in 3 of the last 5 commit messages/);
});

test('commit vocabulary fatigue does not emit when stems are diverse', () => {
  const finding = detectCommitVocabularyFatigue([
    '[codex] Add',
    '[codex] Refactor',
    '[codex] Test',
    '[codex] Document',
    '[codex] Fix',
  ], { windowCommits: 5, minRepeats: 3 });

  assert.equal(finding, null);
});

test('commit vocabulary fatigue strips ing and ed suffixes only', () => {
  const finding = detectCommitVocabularyFatigue([
    '[codex] Hardening',
    '[codex] Hardened',
    '[codex] Harden',
    '[codex] Close',
    '[codex] Tighten',
  ], { windowCommits: 5, minRepeats: 3 });

  assert.equal(finding?.stem, 'harden');
  assert.equal(finding?.count, 3);
});

test('commit vocabulary fatigue strips conventional-commit punctuation', () => {
  const finding = detectCommitVocabularyFatigue([
    '[codex] fix: watcher prompt context',
    '[codex] Fix reviewer prompt context',
    '[codex] fix, reviewer tests',
    '[codex] Close',
    '[codex] Tighten',
  ], { windowCommits: 5, minRepeats: 3 });

  assert.equal(finding?.stem, 'fix');
  assert.equal(finding?.count, 3);
});

test('commit vocabulary fatigue does not collapse short ed/ing verbs', () => {
  const finding = detectCommitVocabularyFatigue([
    '[codex] Speed reviewer path',
    '[codex] Embed prompt evidence',
    '[codex] Bring docs along',
    '[codex] Fix tests',
    '[codex] Add guardrail',
  ], { windowCommits: 5, minRepeats: 3 });

  assert.equal(finding, null);
});

test('commit vocabulary fatigue waits for full window', () => {
  const finding = detectCommitVocabularyFatigue([
    '[codex] Harden',
    '[codex] Harden',
    '[codex] Harden',
  ], { windowCommits: 5, minRepeats: 3 });

  assert.equal(finding, null);
});

test('commit vocabulary fatigue does not emit for empty commit history', () => {
  const finding = detectCommitVocabularyFatigue([], { windowCommits: 5, minRepeats: 3 });

  assert.equal(finding, null);
});

test('commit vocabulary fatigue resolves window and repeat threshold from CFG shape', () => {
  const cfg = {
    get(key, fallback) {
      const values = {
        'agent_control.codex_runaway_guardrails.vocabulary_fatigue_window_commits': 4,
        'agent_control.codex_runaway_guardrails.vocabulary_fatigue_min_repeats': 2,
      };
      return values[key] ?? fallback;
    },
  };

  const resolved = resolveVocabularyFatigueConfig({ cfg });
  assert.deepEqual(resolved, { windowCommits: 4, minRepeats: 2 });

  const finding = detectCommitVocabularyFatigue([
    '[codex] Add',
    '[codex] Harden',
    '[codex] Harden',
    '[codex] Fix',
  ], resolved);
  assert.equal(finding?.stem, 'harden');
  assert.equal(finding?.count, 2);
  assert.equal(finding?.window, 4);
});

test('vocabulary fatigue finding is ignored by merge-agent blocker gate', () => {
  const decision = pickMergeAgentDispatch({
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 123,
    prState: 'open',
    merged: false,
    labels: [],
    mergeable: 'MERGEABLE',
    checksConclusion: 'SUCCESS',
    lastVerdict: 'Comment only',
    remediationCurrentRound: 1,
    remediationMaxRounds: 1,
    blockingFindingCount: 0,
    blockingFindingState: 'known',
    vocabularyFatigueFinding: {
      kind: 'remediation-vocabulary-fatigue',
      severity: 'info',
      blocking: false,
      stem: 'harden',
      count: 3,
      window: 5,
      detail: 'informational',
    },
  });

  assert.equal(decision, 'dispatch');
});
