import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

import { openFinalizationShadowStore } from '../src/finalization/shadow-store.mjs';
import { buildShadowReport, renderShadowReport } from '../src/finalization/shadow-report.mjs';
import { finalizationMain } from '../src/finalization-cli.mjs';

const NOW = '2026-07-17T12:00:00.000Z';
const daysAgo = (n) => new Date(Date.parse(NOW) - n * 86400000).toISOString();

// Hand-built observations for precise control of disposition / organic markers.
function obs(fields) {
  const {
    subjectExternalId, observedAt, v1, v2, v2reason,
    relation, direction, cls, ref, disposition,
    sawHeadMove = false, sawExhaustion = false, override = null,
  } = fields;
  return {
    subjectKey: { domainId: 'code-pr', subjectExternalId },
    revisionRef: 'sha-A',
    observedAt,
    v1Action: { kind: v1 },
    v2Decision: { kind: v2, subjectKey: null, revisionRef: 'sha-A', observedAt, reason: v2reason },
    classification: { relation, direction, class: cls, ref: ref ?? null, disposition, reason: 'fixture' },
    foldError: false,
    sawHeadMove,
    sawExhaustion,
    dispositionOverride: override,
  };
}

function seedNotPromotable() {
  return [
    // 8 days of coverage from an old agreement.
    obs({ subjectExternalId: 'owner/repo#600', observedAt: daysAgo(8), v1: 'merged', v2: 'finalize-now', v2reason: 'clean verdict, green checks at current revision', relation: 'agree', direction: 'benign', cls: 'concur', disposition: 'resolved' }),
    // An in-window agreement that carries the organic head-move + exhaustion markers.
    obs({ subjectExternalId: 'owner/repo#605', observedAt: daysAgo(2), v1: 'hammer-dispatch', v2: 'remediate', v2reason: 'final coverage-gated remediation', relation: 'agree', direction: 'benign', cls: 'concur', disposition: 'resolved', sawHeadMove: true, sawExhaustion: true }),
    // #612 — auto-attributed v1 defect (dispositioned).
    obs({ subjectExternalId: 'owner/repo#612', observedAt: daysAgo(1), v1: 'merged', v2: 'wait', v2reason: 'required check missing', relation: 'diverge', direction: 'v1-defect', cls: 'ci-impatience', ref: 'AR#550', disposition: 'resolved' }),
    // #618 — open, needs triage (blocks promotion).
    obs({ subjectExternalId: 'owner/repo#618', observedAt: daysAgo(1), v1: 'hammer-dispatch', v2: 'finalize-now', v2reason: 'clean verdict, green checks at current revision', relation: 'diverge', direction: 'open', cls: 'unclassified', disposition: 'open' }),
  ];
}

test('report model counts agreements vs divergences and computes the promotion verdict', () => {
  const model = buildShadowReport({ observations: seedNotPromotable(), now: NOW, windowDays: 7 });
  assert.equal(model.shadowed, 3, 'the 8-day-old observation is outside the window');
  assert.equal(model.agree, 1);
  assert.equal(model.diverge, 2);
  assert.equal(model.openDivergences, 1);
  assert.equal(model.organicHeadMoves, 1);
  assert.equal(model.exhaustionCloses, 1);
  assert.equal(model.coverage.enoughDays, true);
  assert.equal(model.promotable, false);
  assert.deepEqual(model.blockers, ['1 open divergence']);
});

test('render matches the Win 3 shadow-report shape', () => {
  const model = buildShadowReport({ observations: seedNotPromotable(), now: NOW, windowDays: 7 });
  const out = renderShadowReport(model);
  const lines = out.split('\n');
  assert.equal(lines[0], 'shadowed finalizations: 3   agree: 1   diverge: 2');
  assert.match(lines[1], /^ {2}#612 v1=merged\s+v2=wait\(required check missing\)\s+\[v1 defect: AR#550 class\]$/);
  assert.match(lines[2], /^ {2}#618 v1=hammer-dispatch\s+v2=finalize-now \(verdict@head clean\)\s+\[triage open\]$/);
  assert.equal(lines[3], 'verdict: NOT promotable (1 open divergence)');
});

test('a fully-dispositioned window with organic coverage is promotable (exact snapshot)', () => {
  const observations = [
    obs({ subjectExternalId: 'owner/repo#600', observedAt: daysAgo(8), v1: 'merged', v2: 'finalize-now', v2reason: 'clean verdict, green checks at current revision', relation: 'agree', direction: 'benign', cls: 'concur', disposition: 'resolved' }),
    obs({ subjectExternalId: 'owner/repo#605', observedAt: daysAgo(2), v1: 'merged', v2: 'finalize-now', v2reason: 'clean verdict, green checks at current revision', relation: 'agree', direction: 'benign', cls: 'concur', disposition: 'resolved', sawHeadMove: true, sawExhaustion: true }),
  ];
  const out = renderShadowReport(buildShadowReport({ observations, now: NOW, windowDays: 7 }));
  assert.equal(out, [
    'shadowed finalizations: 1   agree: 1   diverge: 0',
    'verdict: promotable',
  ].join('\n'));
});

test('the promotion gate blocks on missing organic observations and thin coverage', () => {
  // One recent divergence-free agreement, no head-move, no exhaustion, <7 days.
  const observations = [
    obs({ subjectExternalId: 'owner/repo#700', observedAt: daysAgo(1), v1: 'merged', v2: 'finalize-now', v2reason: 'clean verdict, green checks at current revision', relation: 'agree', direction: 'benign', cls: 'concur', disposition: 'resolved' }),
  ];
  const model = buildShadowReport({ observations, now: NOW, windowDays: 7 });
  assert.equal(model.promotable, false);
  assert.ok(model.blockers.some((b) => /insufficient shadow coverage/.test(b)));
  assert.ok(model.blockers.includes('no organic head-move observed in shadow'));
  assert.ok(model.blockers.includes('no budget-exhaustion close observed in shadow'));
});

test('organic promotion markers count across the full shadow period', () => {
  const observations = [
    obs({ subjectExternalId: 'owner/repo#699', observedAt: daysAgo(8), v1: 'merged', v2: 'finalize-now', relation: 'agree', direction: 'benign', cls: 'concur', disposition: 'resolved', sawHeadMove: true, sawExhaustion: true }),
    obs({ subjectExternalId: 'owner/repo#700', observedAt: daysAgo(1), v1: 'merged', v2: 'finalize-now', relation: 'agree', direction: 'benign', cls: 'concur', disposition: 'resolved' }),
  ];
  const model = buildShadowReport({ observations, now: NOW, windowDays: 7 });
  assert.equal(model.shadowed, 1);
  assert.equal(model.organicHeadMoves, 1);
  assert.equal(model.exhaustionCloses, 1);
  assert.equal(model.promotable, true);
});

test('buildShadowReport accepts SQL-derived coverage for windowed observations', () => {
  const observations = [
    obs({ subjectExternalId: 'owner/repo#700', observedAt: daysAgo(1), v1: 'merged', v2: 'finalize-now', relation: 'agree', direction: 'benign', cls: 'concur', disposition: 'resolved' }),
  ];
  const model = buildShadowReport({
    observations,
    now: NOW,
    windowDays: 7,
    coverage: {
      earliestObservedAt: daysAgo(8),
      organicHeadMoves: 1,
      exhaustionCloses: 1,
    },
  });
  assert.equal(model.shadowed, 1);
  assert.equal(model.coverage.enoughDays, true);
  assert.equal(model.organicHeadMoves, 1);
  assert.equal(model.exhaustionCloses, 1);
  assert.equal(model.promotable, true);
});

test('a human override supersedes the classifier proposal in the report', () => {
  const observations = seedNotPromotable();
  // Re-open the auto-attributed #612 v1-defect — the operator disagrees.
  observations[2].dispositionOverride = { disposition: 'open', note: 'not convinced', principal: 'op', at: daysAgo(0) };
  const model = buildShadowReport({ observations, now: NOW, windowDays: 7 });
  assert.equal(model.openDivergences, 2, 'the overridden divergence now counts as open');
  const d612 = model.divergences.find((d) => d.label === '#612');
  assert.equal(d612.disposition, 'open');
  assert.equal(d612.overridden, true);
  assert.match(d612.tag, /overridden/);
});

// --- CLI wiring ---

function fakeIo(store) {
  const out = [];
  const err = [];
  return {
    io: {
      now: NOW,
      openStore: () => store,
      stdout: { write: (s) => out.push(s) },
      stderr: { write: (s) => err.push(s) },
    },
    out,
    err,
  };
}

test('finalization shadow-report CLI prints the operator block and exits 0', () => {
  const store = openFinalizationShadowStore({ db: new Database(':memory:') });
  for (const o of seedNotPromotable()) store.append(o);
  const { io, out } = fakeIo(store);
  const code = finalizationMain(['shadow-report', '--days', '7'], io);
  assert.equal(code, 0);
  const text = out.join('');
  assert.match(text, /shadowed finalizations: 3 {3}agree: 1 {3}diverge: 2/);
  assert.match(text, /verdict: NOT promotable \(1 open divergence\)/);
});

test('finalization shadow-report --json emits the full model', () => {
  const store = openFinalizationShadowStore({ db: new Database(':memory:') });
  for (const o of seedNotPromotable()) store.append(o);
  const { io, out } = fakeIo(store);
  const code = finalizationMain(['shadow-report', '--json', '--days', '7'], io);
  assert.equal(code, 0);
  const model = JSON.parse(out.join(''));
  assert.equal(model.promotable, false);
  assert.equal(model.diverge, 2);
  assert.equal(model.openDivergences, 1);
  assert.equal(model.windowDays, 7);
});

test('finalization shadow-report reads only the window and uses aggregate coverage', () => {
  let readWindow = null;
  let coverageRead = false;
  let closed = false;
  const store = {
    read(window) {
      readWindow = window;
      return seedNotPromotable().filter((o) => Date.parse(o.observedAt) >= Date.parse(daysAgo(7)));
    },
    readCoverage() {
      coverageRead = true;
      return {
        earliestObservedAt: daysAgo(8),
        organicHeadMoves: 1,
        exhaustionCloses: 1,
      };
    },
    close() {
      closed = true;
    },
  };
  const { io, out } = fakeIo(store);
  const code = finalizationMain(['shadow-report', '--json', '--days', '7'], io);
  const model = JSON.parse(out.join(''));

  assert.equal(code, 0);
  assert.deepEqual(readWindow, { from: daysAgo(7), to: NOW });
  assert.equal(coverageRead, true);
  assert.equal(closed, true);
  assert.equal(model.shadowed, 3);
  assert.equal(model.coverage.enoughDays, true);
});

test('finalization shadow-report does not create a database or data directory', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'shadow-report-readonly-'));
  const out = [];
  const err = [];
  const code = finalizationMain(['shadow-report', '--root', rootDir], {
    now: NOW,
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => err.push(s) },
  });
  assert.equal(code, 1);
  assert.equal(out.length, 0);
  assert.match(err.join(''), /could not build shadow report/);
  assert.equal(existsSync(join(rootDir, 'data')), false);
});

test('an unknown finalization subcommand fails loud', () => {
  const { io, err } = fakeIo(null);
  const code = finalizationMain(['bogus'], io);
  assert.equal(code, 2);
  assert.match(err.join(''), /unknown finalization command bogus/);
});

test('a bad --days value is rejected with usage', () => {
  const { io, err } = fakeIo(null);
  const code = finalizationMain(['shadow-report', '--days', '-3'], io);
  assert.equal(code, 2);
  assert.match(err.join(''), /--days requires a positive number/);
});
