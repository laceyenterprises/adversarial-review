import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sentence = 'Cite files as repository-relative `path:line`; never link to a local file.';
test('every reviewer stage asks once for repository-relative citations', () => {
  const prompts = join(root, 'prompts');
  for (const domain of readdirSync(prompts)) {
    for (const name of readdirSync(join(prompts, domain))) {
      if (!name.startsWith('reviewer.') || name.endsWith('.addendum.md')) continue;
      const text = readFileSync(join(prompts, domain, name), 'utf8');
      assert.equal(text.split(sentence).length - 1, 1, `${domain}/${name}`);
    }
  }
});
test('shared remediation reply instructions ask once for repository-relative citations', () => {
  const text = readFileSync(join(root, 'src/remediation-prompt-builder.mjs'), 'utf8').replaceAll('\\`', '`');
  assert.equal(text.split(sentence).length - 1, 1);
});
test('Argus citation directive follows the complete opening paragraph', () => {
  const text = readFileSync(join(root, 'prompts/argus-security/reviewer.md'), 'utf8');
  const [opening, citations] = text.split(/\n\s*\n/);
  assert.match(opening, /A pull\s+request was routed to you/);
  assert.match(opening, /change\.$/);
  assert.equal(citations, sentence);
});
