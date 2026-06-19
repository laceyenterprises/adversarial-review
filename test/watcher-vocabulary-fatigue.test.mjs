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

test('commit vocabulary fatigue groups base and inflected verb forms', () => {
  const finding = detectCommitVocabularyFatigue([
    '[codex] Update watcher path',
    '[codex] Updated reviewer path',
    '[codex] Updating tests',
    '[codex] Close',
    '[codex] Tighten',
  ], { windowCommits: 5, minRepeats: 3 });

  assert.equal(finding?.stem, 'updat');
  assert.equal(finding?.count, 3);
});

test('commit vocabulary fatigue still groups ing and ed suffixes for longer verbs', () => {
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

test('commit vocabulary fatigue does not emit for diverse short verbs', () => {
  const finding = detectCommitVocabularyFatigue([
    '[codex] Speed reviewer path',
    '[codex] Embed prompt evidence',
    '[codex] Bring docs along',
    '[codex] Fix tests',
    '[codex] Add guardrail',
  ], { windowCommits: 5, minRepeats: 3 });

  assert.equal(finding, null);
});

test('commit vocabulary fatigue collapses mixed-tense runs regardless of length', () => {
  // Update(6)->updat, Updated(7)->updat, updating->updat all collapse; the
  // previous `length > 5` guard left Update->update vs Updated->updat and
  // under-counted (ported from closed PR #337's uniform stemmer).
  const finding = detectCommitVocabularyFatigue([
    '[codex] Update',
    '[codex] Updated',
    '[codex] updating',
    '[codex] Refactor',
    '[codex] Tidy',
  ], { windowCommits: 5, minRepeats: 3 });

  assert.equal(finding?.stem, 'updat');
  assert.equal(finding?.count, 3);
});

test('commit vocabulary fatigue ignores leading ticket-id prefix on same-ticket iteration', () => {
  // Five commits on one ticket are the *normal* remediation pattern and must
  // not masquerade as vocabulary fatigue (ported from closed PR #337's sharpest
  // finding — the survivor stemmed `CRG-09:` to `crg-09` and fired).
  const finding = detectCommitVocabularyFatigue([
    '[codex] CRG-09: add reviewer cycle cap',
    '[codex] CRG-09: handle rereview gating',
    '[codex] CRG-09: tidy tests',
    '[codex] CRG-09: document the cap',
    '[codex] CRG-09: address review',
  ], { windowCommits: 5, minRepeats: 3 });

  assert.equal(finding, null);
});

test('commit vocabulary fatigue still fires with one unparseable subject in the window', () => {
  // A single subject that normalizes to empty must not suppress the whole scan;
  // minRepeats is counted against the stems that actually parsed (fix #3).
  const messages = [];
  const finding = detectCommitVocabularyFatigue([
    '[codex] Harden',
    '[codex] Harden',
    '[codex] Harden',
    '[codex] !!!',
    '[codex] Tighten',
  ], {
    windowCommits: 5,
    minRepeats: 3,
    logger: {
      debug(message) {
        messages.push(message);
      },
    },
  });

  assert.equal(finding?.stem, 'harden');
  assert.equal(finding?.count, 3);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /parsed 4 of 5 commit subjects/);
});

test('commit vocabulary fatigue reports the dominant stem on competing repeats', () => {
  // When two stems both cross the threshold, report the most-repeated one
  // (ported from closed PR #342); ties break lexicographically smallest.
  const finding = detectCommitVocabularyFatigue([
    '[codex] Add a',
    '[codex] Add b',
    '[codex] Add c',
    '[codex] Add d',
    '[codex] Fix e',
    '[codex] Fix f',
    '[codex] Fix g',
  ], { windowCommits: 7, minRepeats: 3 });

  assert.equal(finding?.stem, 'add');
  assert.equal(finding?.count, 4);
});

test('commit vocabulary fatigue breaks dominant-stem ties lexicographically', () => {
  const finding = detectCommitVocabularyFatigue([
    '[codex] Fix a',
    '[codex] Fix b',
    '[codex] Fix c',
    '[codex] Add d',
    '[codex] Add e',
    '[codex] Add f',
  ], { windowCommits: 6, minRepeats: 3 });

  // Both `fix` and `add` appear 3 times; `add` < `fix` lexicographically.
  assert.equal(finding?.stem, 'add');
  assert.equal(finding?.count, 3);
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

test('commit vocabulary fatigue still logs debug context when a subject cannot be parsed', () => {
  // The whole window parses to fewer than `window` stems but still none cross
  // the threshold; the debug line is emitted and the scan returns null.
  const messages = [];
  const finding = detectCommitVocabularyFatigue([
    '[codex] Add',
    '[codex] Refactor',
    '[codex] Test',
    '[codex] !!!',
    '[codex] Fix',
  ], {
    windowCommits: 5,
    minRepeats: 3,
    logger: {
      debug(message) {
        messages.push(message);
      },
    },
  });

  assert.equal(finding, null);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /parsed 4 of 5 commit subjects/);
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
