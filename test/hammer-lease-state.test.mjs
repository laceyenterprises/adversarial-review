import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hammerLeaseState } from '../bin/hammer-lease-state.mjs';

const head = 'a'.repeat(40);
const identity = { repo: 'fixture/repo', base: 'main', pr: 42, head };
const holder = { holderPr: 42, holderHead: head, leaseId: 'fixture-lease' };
const receipt = { ...holder, event: 'release', releasedAt: '2026-01-01T00:00:00Z' };

test('lease query observes PR/head releases and conservatively reports an unreleased holder', () => {
  const query = (current, rows = [], patch = {}) => hammerLeaseState({ ...identity, ...patch }, {
    inspect: () => ({ holder: current }), history: () => rows,
  });
  assert.equal(query(null), 'none');
  assert.equal(query(null, [receipt]), 'released');
  assert.equal(query(null, [{ ...receipt, holderHead: 'b'.repeat(40) }]), 'none');
  assert.equal(query(null, [{ ...receipt, holderPr: 99 }]), 'none');
  assert.equal(query(holder, [receipt]), 'held', 'current holder outranks old release evidence');
  assert.equal(query({ ...holder, holderHead: 'b'.repeat(40) }), 'held', 'a rebase cannot imply release');
  assert.equal(query({ ...holder, pastDeadline: true, holderPidLive: false }), 'held');
  assert.equal(query({ ...holder, holderPr: 99 }), 'none', 'another PR is not our held lease');
  assert.equal(query({ ...holder, holderPr: 99 }, [receipt]), 'released');
  assert.equal(query(null, [receipt, { ...holder, event: 'grant', releasedAt: null }]), 'none');
  assert.throws(() => query({}), /invalid holder/);
  assert.throws(() => query(null, [], { head: 'short' }), /invalid PR\/head/);
  assert.throws(() => query(null, [], { pr: 0 }), /invalid PR\/head/);
  assert.throws(() => hammerLeaseState(identity, { inspect: () => { throw new Error('unreadable'); } }), /unreadable/);
});

test('lease-state CLI reads isolated lease files without changing them and fails without a state on bad data', t => {
  const root = mkdtempSync(join(tmpdir(), 'hammer-lease-state-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'data', 'merge-leases');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'fixture__repo__main.json');
  const history = join(dir, 'fixture__repo__main.history.jsonl');
  const args = [new URL('../bin/hammer-lease-state.mjs', import.meta.url).pathname,
    '--root-dir', root, '--repo', identity.repo, '--base', identity.base, '--pr', '42', '--head', head];
  const run = () => spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 5000 });
  writeFileSync(file, JSON.stringify(holder));
  writeFileSync(history, `${JSON.stringify(receipt)}\n`);
  const before = [readFileSync(file, 'utf8'), readFileSync(history, 'utf8'), readdirSync(dir)];
  const held = run();
  assert.equal(held.status, 0, held.stderr);
  assert.equal(held.stdout, 'held\n');
  assert.deepEqual([readFileSync(file, 'utf8'), readFileSync(history, 'utf8'), readdirSync(dir)], before);
  rmSync(file);
  const released = run();
  assert.equal(released.status, 0, released.stderr);
  assert.equal(released.stdout, 'released\n');
  rmSync(history);
  assert.equal(run().stdout, 'none\n');
  writeFileSync(file, '{broken');
  const failed = run();
  assert.equal(failed.status, 1);
  assert.equal(failed.stdout, '');
  assert.match(failed.stderr, /lease-state-unavailable/);
});
