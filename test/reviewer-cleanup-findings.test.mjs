import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fixtureLifetime, killFixtureChild } from './helpers/fixture-child.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  cleanupFindingPath,
  readReviewerCleanupFindings,
  recheckReviewerCleanupFindings,
  writeReviewerCleanupFinding,
} from '../src/reviewer-cleanup-findings.mjs';

test('posted reviewer cleanup findings persist and clear after a later dead probe', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'reviewer-cleanup-findings-'));
  const finding = {
    id: 'reviewer:posted_process_group_leak',
    severity: 'warning',
    repo: 'laceyenterprises/agent-os',
    prNumber: 6917,
    reviewerSessionUuid: 'session-6917',
    reviewerPgid: 9182,
    postedAt: '2026-09-20T06:29:34Z',
  };

  const written = writeReviewerCleanupFinding(rootDir, finding, {
    now: new Date('2026-09-20T06:30:00Z'),
  });
  assert.equal(written.firstObservedAt, '2026-09-20T06:30:00.000Z');
  assert.equal(written.checks, 1);
  assert.equal(written.matched, null);
  assert.deepEqual(readReviewerCleanupFindings(rootDir).map((item) => item.reviewerSessionUuid), ['session-6917']);

  const alive = recheckReviewerCleanupFindings({
    rootDir,
    now: new Date('2026-09-20T06:31:00Z'),
    log: { warn() {} },
    probeSessionImpl: () => ({ alive: true, matched: true }),
  });
  assert.deepEqual(alive, { scanned: 1, stillAlive: 1, cleared: 0, unknown: 0 });
  assert.equal(readReviewerCleanupFindings(rootDir)[0].checks, 2);

  const dead = recheckReviewerCleanupFindings({
    rootDir,
    log: { warn() {} },
    probeSessionImpl: () => ({ alive: false, matched: false }),
  });
  assert.deepEqual(dead, { scanned: 1, stillAlive: 0, cleared: 1, unknown: 0 });
  assert.deepEqual(readReviewerCleanupFindings(rootDir), []);
  assert.doesNotThrow(() => cleanupFindingPath(rootDir, 'session-6917'));
});

test('cleanup finding recheck passes the live process group and session to its probe', async (t) => {
  const psProbe = spawnSync('/bin/ps', ['-p', String(process.pid), '-o', 'command='], { encoding: 'utf8' });
  if (psProbe.error || psProbe.status !== 0 || !psProbe.stdout?.trim()) {
    t.skip('worker sandbox blocks process introspection required by the production probe');
    return;
  }
  const rootDir = mkdtempSync(join(tmpdir(), 'reviewer-cleanup-findings-live-'));
  const sessionUuid = `cleanup-finding-${process.pid}-${Date.now()}`;
  const child = spawn(
    process.execPath,
    ['-e', `${fixtureLifetime} setTimeout(() => {}, 30_000); // ${sessionUuid}`],
    { detached: true, stdio: 'ignore' }
  );
  try {
    writeReviewerCleanupFinding(rootDir, {
      repo: 'laceyenterprises/agent-os',
      prNumber: 6917,
      reviewerSessionUuid: sessionUuid,
      reviewerPgid: child.pid,
      matched: true,
      postedAt: '2026-09-20T06:29:34Z',
    });

    let psCommand;
    let probeSessionImpl;
    try {
      psCommand = execFileSync('ps', ['-p', String(child.pid), '-o', 'command='], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      // Only sandbox failures to execute ps use the injected probe.
      probeSessionImpl = ({ pgid, sessionUuid: probedSession }) => {
        assert.equal(pgid, child.pid);
        assert.equal(probedSession, sessionUuid);
        process.kill(child.pid, 0);
        return { alive: true, matched: true };
      };
    }
    if (psCommand !== undefined) {
      assert.ok(psCommand.includes(sessionUuid), 'ps omitted the child session UUID');
    }
    const result = recheckReviewerCleanupFindings({
      rootDir,
      log: { warn() {} },
      probeSessionImpl,
    });

    assert.equal(result.stillAlive, 1);
    assert.equal(readReviewerCleanupFindings(rootDir)[0].matched, true);
  } finally {
    await killFixtureChild(child);
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('cleanup finding recheck uses the production probe argument shape', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'reviewer-cleanup-findings-args-'));
  const sessionUuid = `cleanup-finding-${process.pid}-${Date.now()}`;
  const pgid = 12345;
  const probes = [];
  writeReviewerCleanupFinding(rootDir, {
    repo: 'laceyenterprises/agent-os',
    prNumber: 6917,
    reviewerSessionUuid: sessionUuid,
    reviewerPgid: pgid,
    matched: true,
    postedAt: '2026-09-20T06:29:34Z',
  });

  const result = recheckReviewerCleanupFindings({
    rootDir,
    log: { warn() {} },
    probeSessionImpl: args => {
      probes.push(args);
      return { alive: true, matched: true };
    },
  });

  assert.equal(result.stillAlive, 1);
  assert.deepEqual(probes, [{ pgid, sessionUuid }]);
  assert.equal(readReviewerCleanupFindings(rootDir)[0].matched, true);
});

test('cleanup finding recheck clears recycled process groups with mismatched sessions', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'reviewer-cleanup-findings-recycled-'));
  writeReviewerCleanupFinding(rootDir, {
    repo: 'laceyenterprises/agent-os',
    prNumber: 6917,
    reviewerSessionUuid: 'session-recycled',
    reviewerPgid: 9182,
    matched: true,
    postedAt: '2026-09-20T06:29:34Z',
  });

  const result = recheckReviewerCleanupFindings({
    rootDir,
    log: { warn() {} },
    probeSessionImpl: () => ({ alive: true, matched: false }),
  });

  assert.deepEqual(result, { scanned: 1, stillAlive: 0, cleared: 1, unknown: 0 });
  assert.deepEqual(readReviewerCleanupFindings(rootDir), []);
});

test('cleanup finding recheck honors maxRows cap', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'reviewer-cleanup-findings-cap-'));
  for (const suffix of ['a', 'b']) {
    writeReviewerCleanupFinding(rootDir, {
      repo: 'laceyenterprises/agent-os',
      prNumber: 6917,
      reviewerSessionUuid: `session-${suffix}`,
      reviewerPgid: 9182,
      postedAt: '2026-09-20T06:29:34Z',
    });
  }

  const result = recheckReviewerCleanupFindings({
    rootDir,
    maxRows: 1,
    log: { warn() {} },
    probeSessionImpl: () => ({ alive: true, matched: true }),
  });

  assert.equal(result.scanned, 1);
  assert.equal(result.stillAlive, 1);
  assert.equal(readReviewerCleanupFindings(rootDir).length, 2);
});

test('cleanup finding recheck prunes stale findings by first observation age', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'reviewer-cleanup-findings-age-'));
  writeReviewerCleanupFinding(rootDir, {
    repo: 'laceyenterprises/agent-os',
    prNumber: 6917,
    reviewerSessionUuid: 'session-stale',
    reviewerPgid: 9182,
    postedAt: '2026-09-20T06:29:34Z',
  }, {
    now: new Date('2026-09-20T06:30:00Z'),
  });

  const result = recheckReviewerCleanupFindings({
    rootDir,
    now: new Date('2026-09-20T06:40:01Z'),
    maxAgeMs: 10 * 60 * 1000,
    log: { warn() {} },
    probeSessionImpl: () => ({ alive: true, matched: true }),
  });

  assert.deepEqual(result, { scanned: 1, stillAlive: 0, cleared: 1, unknown: 0 });
  assert.deepEqual(readReviewerCleanupFindings(rootDir), []);
});
