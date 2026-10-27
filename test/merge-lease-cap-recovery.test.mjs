import './helpers/load-aware-timeout-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { recoverMergeLeaseCap } from '../src/ama/merge-lease-cap-recovery.mjs';
import { main as mergeLeaseMain } from '../bin/merge-lease.mjs';
import { observeClosureWait } from '../src/ama/closure-wait.mjs';

const identity = { repo: 'fixture/repo', prNumber: 42, headSha: 'a'.repeat(40) };
const pr = { state: 'OPEN', headRefOid: identity.headSha, labels: [], mergeable: 'MERGEABLE' };

test('GATECAPBASE-01: a capped stable head reaches the existing durable page exactly once', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'cap-recovery-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const pages = [];
  for (let i = 0; i < 2; i++) {
    const result = await recoverMergeLeaseCap({ rootDir, ...identity, pr,
      observeClosureWaitImpl: args => observeClosureWait({ ...args,
        pageImpl: async (...page) => pages.push(page) }) });
    assert.equal(result.owner, 'closure-recovery');
    assert.equal(result.action, 'page');
    assert.equal(result.paged, true);
  }
  assert.equal(pages.length, 1);
  assert.match(pages[0][0], /without an operator attempt reset/);
});

for (const mergeability of [{ mergeable: 'CONFLICTING' }, { mergeable: 'UNKNOWN', mergeStateStatus: 'DIRTY' }]) {
  test(`GATECAPBASE-01: capped conflict returns to its hammer owner (${JSON.stringify(mergeability)})`, async () => {
    const result = await recoverMergeLeaseCap({ ...identity, pr: { ...pr, ...mergeability },
      observeClosureWaitImpl: () => assert.fail('conflict owner needs no page') });
    assert.equal(result.owner, 'hammer');
    assert.equal(result.action, 'resolve-conflict');
  });
}

for (const change of [{ state: 'MERGED' }, { state: 'CLOSED' }, { headRefOid: 'b'.repeat(40) },
  { labels: [{ name: 'no-merge-hold' }] }, { isDraft: true }]) {
  test(`GATECAPBASE-01: cap recovery respects live admission ${JSON.stringify(change)}`, async () => {
    const result = await recoverMergeLeaseCap({ ...identity,
      pr: { ...pr, mergeable: 'CONFLICTING', ...change },
      observeClosureWaitImpl: () => assert.fail('no page for fenced or terminal head') });
    assert.equal(result.action, 'wait');
  });
}

test('GATECAPBASE-01: page failure remains retryable', async () => {
  await assert.rejects(recoverMergeLeaseCap({ ...identity, pr,
    observeClosureWaitImpl: async () => { throw new Error('synthetic delivery unavailable'); } }), /delivery unavailable/);
});

test('GATECAPBASE-01: recover-cap CLI binds the refreshed snapshot to its requested head', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'cap-recovery-cli-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const snapshot = join(rootDir, 'pr.json');
  writeFileSync(snapshot, JSON.stringify({ ...pr, mergeable: 'CONFLICTING' }));
  let output = '';
  const code = await mergeLeaseMain(['recover-cap', '--root-dir', rootDir,
    '--repo', identity.repo, '--pr', String(identity.prNumber), '--head', identity.headSha,
    '--pr-state-file', snapshot], { stdout: { write: chunk => { output += chunk; } } });
  assert.equal(code, 0);
  assert.equal(JSON.parse(output).action, 'resolve-conflict');
});
