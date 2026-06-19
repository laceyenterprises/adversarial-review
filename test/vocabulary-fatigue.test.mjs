import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig } from '../src/config-loader.mjs';
import { classifyBlockingFindings, pickMergeAgentDispatch } from '../src/follow-up-merge-agent.mjs';
import {
  appendVocabularyFatigueFindingToReviewBody,
  detectVocabularyFatigue,
  resolveVocabularyFatigueConfig,
} from '../src/vocabulary-fatigue.mjs';

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'vocab-fatigue-'));
}

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

test('vocabulary fatigue strips only ing and ed suffixes', () => {
  const finding = findingFor([
    '[codex] Hardening',
    '[codex] Hardened',
    '[codex] Harden',
    '[codex] Close',
    '[codex] Tighten',
  ]);

  assert.equal(finding.stem, 'harden');
  assert.equal(finding.count, 3);
});

test('vocabulary fatigue resolves window and min repeats from CFG', () => {
  const dir = tmpDir();
  try {
    const topPath = join(dir, 'config.yaml');
    writeFileSync(topPath, [
      'version: 1',
      'agent_control:',
      '  codex_runaway_guardrails:',
      '    vocabulary_fatigue_window_commits: 4',
      '    vocabulary_fatigue_min_repeats: 2',
      '',
    ].join('\n'));
    const cfg = loadConfig({ topPath, env: {} });
    const resolved = resolveVocabularyFatigueConfig(cfg);

    assert.deepEqual(resolved, { windowCommits: 4, minRepeats: 2 });
    assert.equal(findingFor([
      '[codex] Add',
      '[codex] Harden',
      '[codex] Hardened',
      '[codex] Close',
    ], resolved).stem, 'harden');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('vocabulary fatigue defaults and insufficient history are non-emitting', () => {
  const cfg = loadConfig({ topPath: join(tmpdir(), 'missing-vocabulary-fatigue-config.yaml'), env: {} });
  assert.deepEqual(resolveVocabularyFatigueConfig(cfg), { windowCommits: 5, minRepeats: 3 });
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

  assert.match(reviewBody, /## Non-blocking Issues/);
  assert.match(reviewBody, /blocking: false/);
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
    '## Non-blocking Issues',
    '- None.',
    '',
    '## Verdict',
    'Comment only',
    '',
  ].join('\n'), finding);
  assert.doesNotMatch(existingNonBlocking, /- None\./);
  assert.match(existingNonBlocking, /remediation-vocabulary-fatigue/);
});
