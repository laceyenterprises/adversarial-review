// Round-2 review regressions for PR #126.
//
// All three blocking findings from the operator's manual review get a
// regression test here so the bug class can't recur.
//
// (1) describeStaleDispatch must read audit logs from the HQ ROOT
//     directory, not from the `hq` executable path. The PR's call
//     site previously passed hqPath (the binary) as hqRoot, so the
//     fs.readFileSync lookup landed under e.g. `${hqExe}/dispatch/
//     audit/...` (nonsensical path) and the helper went silent. The
//     fix wires resolveHqRoot(runtimeEnv) into the call site;
//     dispatchMergeAgentForPR end-to-end behavior is covered in
//     `follow-up-merge-agent.test.mjs` (this file pins the lower-
//     level invariant that audit files at the resolved HQ ROOT path
//     are read, not anywhere else).
//
// (2) The dispatchStateProbe must be wired so historical refusal
//     audit rows are NOT promoted to BLOCKED when the same LRQ is
//     now `running` / `succeeded`. Round-1 already implemented the
//     probe in describeStaleDispatch; round-2 fix is that the
//     production caller passes one. Test: when the probe returns a
//     non-stuck status, describeStaleDispatch returns null EVEN
//     when audit rows would otherwise classify as stuck.
//
// (3) stuckDetail must carry launchRequestId so the Sentinel alert's
//     debounce key doesn't collapse to `repo-pr-no-lrq`. Round-2 fix
//     adds `launchRequestId: lrq` to the describeStaleDispatch return
//     value. Test: the return shape exposes the validated LRQ when
//     the helper classifies a dispatch as stuck.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describeStaleDispatch } from '../src/follow-up-merge-agent.mjs';

const NOW = Date.parse('2026-05-18T03:30:00Z');
const LRQ = 'lrq_fb1a7760-4378-4f34-b731-4a1033bec5dd';
const STUCK_DISPATCHED_AT = '2026-05-18T02:00:00Z'; // 90 min before NOW

function tmpHqRoot() {
  return mkdtempSync(path.join(tmpdir(), 'hq-stuck-round2-'));
}

function writeRefusalAudit(hqRoot, lrq, utcDate, count = 5) {
  const dir = path.join(hqRoot, 'dispatch', 'audit', utcDate);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${lrq}.jsonl`);
  const events = [];
  for (let i = 0; i < count; i++) {
    events.push({
      createdAt: '2026-05-18T03:00:00Z',
      decision: 'refuse_admit_memory_pressure',
      structuredReasons: [{ reasonCode: 'memory_pressure' }],
    });
  }
  writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return file;
}

// (1) HQ ROOT vs hq executable — pin that the helper reads the
//     audit file at `${hqRoot}/dispatch/audit/...` and nowhere else.
test('round2: describeStaleDispatch reads audit log from the resolved HQ ROOT directory', () => {
  const hqRoot = tmpHqRoot();
  try {
    writeRefusalAudit(hqRoot, LRQ, '2026-05-18', 5);

    const detail = describeStaleDispatch(
      { dispatchedAt: STUCK_DISPATCHED_AT, launchRequestId: LRQ, trigger: 'merge-agent-requested' },
      { hqRoot, now: NOW },
    );

    assert.notStrictEqual(detail, null,
      'Audit refusals at the HQ ROOT path MUST classify the dispatch as stuck. ' +
      'If this fails, the call site is probably passing the hq EXECUTABLE path again ' +
      'instead of the HQ ROOT directory (round-2 finding #1).');
    assert.strictEqual(detail.refusalCount, 5);
  } finally {
    rmSync(hqRoot, { recursive: true, force: true });
  }
});

test('round2: describeStaleDispatch returns null when hqRoot points at a wrong place (no audit dir)', () => {
  // Simulates the BUG: passing the hq executable path as hqRoot. No
  // `${hqExe}/dispatch/audit/` dir exists. Helper must return null,
  // proving that the wrong-path symptom was indeed "silent" and that
  // the call-site fix matters.
  const wrongHqRoot = mkdtempSync(path.join(tmpdir(), 'wrong-hq-'));
  try {
    // Note: NO writeRefusalAudit — wrongHqRoot has nothing under it
    const detail = describeStaleDispatch(
      { dispatchedAt: STUCK_DISPATCHED_AT, launchRequestId: LRQ },
      { hqRoot: wrongHqRoot, now: NOW },
    );
    assert.strictEqual(detail, null,
      'Wrong hqRoot must produce null (silent), proving that the round-2 ' +
      'call-site fix from hqPath → resolveHqRoot is load-bearing.');
  } finally {
    rmSync(wrongHqRoot, { recursive: true, force: true });
  }
});

// (2) Live-state probe wiring — pin that a non-stuck status overrides
//     a stuck-looking refusal history.
test('round2: dispatchStateProbe returning "running" suppresses stuck classification', () => {
  const hqRoot = tmpHqRoot();
  try {
    writeRefusalAudit(hqRoot, LRQ, '2026-05-18', 5);

    const probe = () => ({ status: 'running' });
    const detail = describeStaleDispatch(
      { dispatchedAt: STUCK_DISPATCHED_AT, launchRequestId: LRQ },
      { hqRoot, now: NOW, dispatchStateProbe: probe },
    );

    assert.strictEqual(detail, null,
      'Live "running" status must suppress the stuck classification — ' +
      'historical refusals predate a successful later admit (round-2 finding #2).');
  } finally {
    rmSync(hqRoot, { recursive: true, force: true });
  }
});

test('round2: dispatchStateProbe returning "succeeded" suppresses stuck classification', () => {
  const hqRoot = tmpHqRoot();
  try {
    writeRefusalAudit(hqRoot, LRQ, '2026-05-18', 5);

    const probe = () => ({ status: 'succeeded' });
    const detail = describeStaleDispatch(
      { dispatchedAt: STUCK_DISPATCHED_AT, launchRequestId: LRQ },
      { hqRoot, now: NOW, dispatchStateProbe: probe },
    );

    assert.strictEqual(detail, null,
      'Live "succeeded" status must suppress the stuck classification (round-2 #2).');
  } finally {
    rmSync(hqRoot, { recursive: true, force: true });
  }
});

test('round2: dispatchStateProbe returning a stuck-shaped status still classifies as stuck', () => {
  // Validates the inverse — probe doesn't FORCE non-null when status
  // is in the stuck bucket. (E.g. status: 'requested' shouldn't
  // override audit-row classification.)
  const hqRoot = tmpHqRoot();
  try {
    writeRefusalAudit(hqRoot, LRQ, '2026-05-18', 5);

    const probe = () => ({ status: 'requested' });
    const detail = describeStaleDispatch(
      { dispatchedAt: STUCK_DISPATCHED_AT, launchRequestId: LRQ },
      { hqRoot, now: NOW, dispatchStateProbe: probe },
    );

    assert.notStrictEqual(detail, null,
      'Probe status "requested" is in the stuck-eligible set; refusal ' +
      'audit rows must still classify as stuck.');
  } finally {
    rmSync(hqRoot, { recursive: true, force: true });
  }
});

// (3) stuckDetail must carry the LRQ so the Sentinel alert can key
//     its debounce on it.
test('round2: describeStaleDispatch returns launchRequestId on stuckDetail', () => {
  const hqRoot = tmpHqRoot();
  try {
    writeRefusalAudit(hqRoot, LRQ, '2026-05-18', 5);

    const detail = describeStaleDispatch(
      { dispatchedAt: STUCK_DISPATCHED_AT, launchRequestId: LRQ },
      { hqRoot, now: NOW },
    );

    assert.notStrictEqual(detail, null);
    assert.strictEqual(detail.launchRequestId, LRQ,
      'stuckDetail.launchRequestId must echo the input LRQ so the ' +
      'Sentinel alert in watcher.mjs can use it as the debounce key. ' +
      'Without this, the debounce slot collapses to `repo-pr-no-lrq` ' +
      'and every stuck dispatch on the same PR shares one suppression ' +
      'window (round-2 finding #3).');
  } finally {
    rmSync(hqRoot, { recursive: true, force: true });
  }
});
