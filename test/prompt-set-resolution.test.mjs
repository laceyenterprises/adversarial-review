import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PromptSetResolutionError,
  loadStagePrompt,
  resolvePromptSet,
} from '../src/kernel/prompt-stage.mjs';
import { loadDomainConfig } from '../src/domain-config.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function readPrompt(...parts) {
  return readFileSync(join(ROOT, 'prompts', ...parts), 'utf8').trim();
}

// Assemble every reviewer/remediator stage prompt from a domain's *declared*
// prompt set, exactly as the reviewer/remediator do at load time.
function assembleFromDomain(domainId) {
  const domainConfig = loadDomainConfig(ROOT, domainId);
  const promptSet = resolvePromptSet({ rootDir: ROOT, domainConfig, domainId });
  const stages = ['first', 'middle', 'last'];
  const out = { promptSet };
  for (const actor of ['reviewer', 'remediator']) {
    for (const stage of stages) {
      out[`${actor}.${stage}`] = loadStagePrompt({ rootDir: ROOT, promptSet, actor, stage });
    }
  }
  return out;
}

test('code-pr domain resolves to the code-pr prompt set with byte-identical assembly', () => {
  const assembled = assembleFromDomain('code-pr');

  // The value flows from domains/code-pr.json, not a hardcoded literal.
  assert.equal(assembled.promptSet, 'code-pr');

  // Byte-for-byte parity with the literal prompts/code-pr/*.md files: the
  // config-driven path must produce exactly what the old constant produced.
  for (const actor of ['reviewer', 'remediator']) {
    for (const stage of ['first', 'middle', 'last']) {
      assert.equal(
        assembled[`${actor}.${stage}`],
        readPrompt('code-pr', `${actor}.${stage}.md`),
        `code-pr ${actor}.${stage} must be byte-identical`,
      );
    }
  }
});

test('research-finding domain selects its own prompt set (not code-pr)', () => {
  const assembled = assembleFromDomain('research-finding');

  assert.equal(assembled.promptSet, 'research-finding');

  for (const actor of ['reviewer', 'remediator']) {
    for (const stage of ['first', 'middle', 'last']) {
      assert.equal(
        assembled[`${actor}.${stage}`],
        readPrompt('research-finding', `${actor}.${stage}.md`),
        `research-finding ${actor}.${stage} must come from its own prompt set`,
      );
      // Must NOT be silently serving the code-pr prompt of the same stage.
      assert.notEqual(
        assembled[`${actor}.${stage}`],
        readPrompt('code-pr', `${actor}.${stage}.md`),
        `research-finding ${actor}.${stage} must not fall back to code-pr`,
      );
    }
  }
});

test('unknown promptSet fails loud with a classified error (no fallback)', () => {
  assert.throws(
    () => resolvePromptSet({
      rootDir: ROOT,
      domainConfig: { id: 'made-up', promptSet: 'does-not-exist' },
      domainId: 'made-up',
    }),
    (err) => {
      assert.ok(err instanceof PromptSetResolutionError, 'must be a PromptSetResolutionError');
      assert.equal(err.class, 'prompt-set-resolution');
      assert.equal(err.reason, 'unknown-prompt-set');
      assert.equal(err.promptSet, 'does-not-exist');
      assert.equal(err.domainId, 'made-up');
      assert.match(err.message, /unknown promptSet/);
      return true;
    },
  );
});

test('a domain that declares no promptSet fails loud (never defaults to code-pr)', () => {
  assert.throws(
    () => resolvePromptSet({
      rootDir: ROOT,
      domainConfig: { id: 'no-set' },
      domainId: 'no-set',
    }),
    (err) => {
      assert.ok(err instanceof PromptSetResolutionError);
      assert.equal(err.reason, 'missing-prompt-set');
      assert.equal(err.domainId, 'no-set');
      return true;
    },
  );
});

test('a missing domain config fails loud with a classified error', () => {
  assert.throws(
    () => resolvePromptSet({ rootDir: ROOT, domainConfig: null, domainId: 'ghost' }),
    (err) => {
      assert.ok(err instanceof PromptSetResolutionError);
      assert.equal(err.reason, 'missing-domain-config');
      return true;
    },
  );
});

test('an unsafe promptSet segment is rejected before any disk access', () => {
  assert.throws(
    () => resolvePromptSet({
      rootDir: ROOT,
      domainConfig: { id: 'evil', promptSet: '../escape' },
      domainId: 'evil',
    }),
    (err) => {
      assert.ok(err instanceof PromptSetResolutionError);
      assert.equal(err.reason, 'invalid-prompt-set');
      return true;
    },
  );
});

test('reviewer and remediator resolve the same code-pr prompt set the domain declares', async () => {
  const { REVIEWER_PROMPT_SET } = await import('../src/reviewer.mjs');
  assert.equal(REVIEWER_PROMPT_SET, loadDomainConfig(ROOT, 'code-pr').promptSet);
});
