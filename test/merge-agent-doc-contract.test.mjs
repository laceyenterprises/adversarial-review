import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

function readRepoFile(...parts) {
  return readFileSync(path.join(ROOT, ...parts), 'utf8');
}

test('operator docs describe watcher-owned merge-agent dispatch as the live path', () => {
  const readme = readRepoFile('README.md');
  const runbook = readRepoFile('docs', 'follow-up-runbook.md');
  const spec = readRepoFile('docs', 'SPEC-adversarial-review-auto-remediation.md');

  assert.match(readme, /watcher-owned,[\s\S]{0,80}not an inline branch inside[\s\S]{0,20}`src\/follow-up-jobs\.mjs`/);
  assert.match(readme, /data\/follow-up-jobs\/merge-agent-dispatches\//);
  assert.match(readme, /skip-blockers-present/);

  assert.match(runbook, /Comment-only to merge example/);
  assert.match(runbook, /merge-agent-requested/);
  assert.match(runbook, /skip-already-dispatched/);
  assert.match(runbook, /skip-blockers-present/);
  assert.match(runbook, /current head `abc123`/);
  assert.match(runbook, /older head `def456`/);

  assert.match(spec, /The watcher, not `follow-up-jobs\.mjs`, evaluates merge dispatch/);
  assert.match(spec, /data\/follow-up-jobs\/merge-agent-dispatches\/<repo>-pr-<n>-abc123\.json/);
  assert.match(spec, /ARP-06 \/ #157/);
});

test('operator docs reject stale inline FPOBE merge guidance', () => {
  const docs = [
    readRepoFile('README.md'),
    readRepoFile('docs', 'follow-up-runbook.md'),
    readRepoFile('docs', 'SPEC-adversarial-review-auto-remediation.md'),
  ].join('\n');

  assert.doesNotMatch(
    docs,
    /follow-up-jobs\.mjs[\s\S]{0,80}(dispatches merge-agent|dispatches the merge-agent|merges the PR|auto-merges the PR|implements final-pass-on-budget-exhausted)/i,
    'operator docs must not describe merge dispatch as an inline follow-up-jobs.mjs merge path',
  );
});
