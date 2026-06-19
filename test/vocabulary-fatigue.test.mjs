import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyBlockingFindings, pickMergeAgentDispatch } from '../src/follow-up-merge-agent.mjs';
import {
  appendVocabularyFatigueFindingToReviewBody,
  detectVocabularyFatigue,
} from '../src/vocabulary-fatigue.mjs';

function findingFor(subjects, options) {
  return detectVocabularyFatigue(subjects.map((message) => ({ commit: { message } })), options);
}

test('vocabulary fatigue emits when a stem reaches the default repeat threshold', () => {
  const finding = findingFor([
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

test('vocabulary fatigue does not emit when no stem repeats enough', () => {
  const finding = findingFor([
    '[codex] Add',
    '[codex] Refactor',
    '[codex] Test',
    '[codex] Document',
    '[codex] Fix',
  ]);

  assert.equal(finding, null);
});

test('vocabulary fatigue collapses common commit verb suffixes', () => {
  const finding = findingFor([
    '[codex] Hardening',
    '[codex] Hardened',
    '[codex] Harden',
    '[codex] Close',
    '[codex] Tighten',
  ]);

  assert.equal(finding.stem, 'harden');
  assert.equal(finding.count, 3);

  const thirdPerson = findingFor([
    '[codex] Fixes',
    '[codex] Fixed',
    '[codex] Fix',
    '[codex] Close',
    '[codex] Tighten',
  ]);

  assert.equal(thirdPerson.stem, 'fix');
  assert.equal(thirdPerson.count, 3);

  assert.equal(findingFor([
    '[codex] Address',
    '[codex] Addresses',
    '[codex] Addressed',
    '[codex] Close',
    '[codex] Tighten',
  ]).stem, 'address');
});

test('vocabulary fatigue defaults are module constants, not CFG leaves', () => {
  assert.equal(findingFor([
    '[codex] Add',
    '[codex] Harden',
    '[codex] Hardened',
    '[codex] Harden',
    '[codex] Close',
  ]).stem, 'harden');
});

test('vocabulary fatigue defaults and insufficient history are non-emitting', () => {
  assert.equal(findingFor(['[codex] Harden', '[codex] Harden', '[codex] Harden']), null);
});

test('vocabulary fatigue finding is appended as non-blocking and does not gate merge-agent dispatch', () => {
  const finding = findingFor([
    '[codex] Harden',
    '[codex] Harden',
    '[codex] Harden',
    '[codex] Close',
    '[codex] Tighten',
  ]);
  const reviewBody = appendVocabularyFatigueFindingToReviewBody([
    '## Summary',
    'Clean.',
    '',
    '## Verdict',
    'Comment only',
    '',
  ].join('\n'), finding);

  assert.match(reviewBody, /## Non-blocking issues/);
  assert.match(reviewBody, /- \*\*Remediation vocabulary fatigue advisory\*\*/);
  assert.match(reviewBody, /\*\*File:\*\* n\/a/);
  assert.match(reviewBody, /\*\*Recommended fix:\*\* Informational only/);
  assert.equal(classifyBlockingFindings(reviewBody, { lastVerdict: 'Comment only' }).count, 0);
  assert.equal(classifyBlockingFindings(reviewBody, { lastVerdict: 'Comment only' }).state, 'known');
  assert.equal(pickMergeAgentDispatch({
    lastVerdict: 'Comment only',
    blockingFindingCount: 0,
    blockingFindingState: 'known',
    mergeable: 'MERGEABLE',
    checksConclusion: 'SUCCESS',
    labels: [],
    prState: 'open',
    remediationCurrentRound: 0,
    remediationMaxRounds: 1,
  }), 'dispatch');

  const existingNonBlocking = appendVocabularyFatigueFindingToReviewBody([
    '## Summary',
    'Clean.',
    '',
    '## Non-blocking issues',
    '- None.',
    '',
    '## Verdict',
    'Comment only',
    '',
  ].join('\n'), finding);
  assert.doesNotMatch(existingNonBlocking, /- None\./);
  assert.match(existingNonBlocking, /remediation-vocabulary-fatigue/);
});
