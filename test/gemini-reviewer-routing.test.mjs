// GMW-02 — Gemini always-on third reviewer: routing, mode knob, integrity
// guard, reviewer-identity, and roster surface.
//
// These exercise the pure routing helpers (mode-driven selection + the
// adversarial-integrity hard guard), the reviewer-bot-login identity maps
// (reviewer side resolves to gemini-reviewer-lacey; builder side stays
// codex-reviewer-lacey), and the reviewer-roster debug surface against the
// SPEC §1 mockup. The fallback-mode quota signal is injected so the test does
// not depend on live HRR state.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  applyGeminiReviewerRoute,
  formatReviewerRoster,
  geminiMayReviewBuilder,
  normalizeGeminiReviewerMode,
  reviewerRoster,
  routePR,
  routeSubject,
  GEMINI_REVIEWABLE_BUILDER_CLASSES,
} from '../src/adapters/subject/github-pr/routing.mjs';
import { resolveGeminiReviewerMode } from '../src/role-config.mjs';
import { reviewerRosterMain } from '../src/cli.mjs';
import { resolveReviewerBotLogin } from '../src/review-body-capture.mjs';
import { reviewerBotLogin } from '../src/reviewer-reattach.mjs';

const HERMETIC = { env: {}, topPath: '/dev/null' };

function baseRouteFor(builderClass) {
  return routeSubject({ builderClass }, { ...HERMETIC, geminiReviewerMode: 'off' });
}

// ── mode knob drives selection ─────────────────────────────────────────────

test('GMW-02 always-on: gemini reviews [claude-code], [codex], [clio-agent]', () => {
  for (const builderClass of ['claude-code', 'codex', 'clio-agent']) {
    const route = applyGeminiReviewerRoute({
      builderClass,
      baseRoute: baseRouteFor(builderClass),
      mode: 'always-on',
    });
    assert.equal(route.reviewerModel, 'gemini', `${builderClass} → gemini`);
    assert.equal(route.botTokenEnv, 'GH_GEMINI_REVIEWER_TOKEN');
    assert.equal(route.geminiReviewerSelection.reason, 'always-on-third-reviewer');
    assert.equal(route.geminiReviewerSelection.mode, 'always-on');
  }
});

test('GMW-02 off: routing is the pre-GMW cross-model reviewer (no gemini)', () => {
  const cases = {
    'claude-code': 'codex',
    codex: 'claude',
    'clio-agent': 'claude',
    gemini: 'codex',
    pi: 'codex',
    opencode: 'codex',
    hermes: 'codex',
  };
  for (const [builderClass, expected] of Object.entries(cases)) {
    const base = baseRouteFor(builderClass);
    const route = applyGeminiReviewerRoute({ builderClass, baseRoute: base, mode: 'off' });
    assert.equal(route.reviewerModel, expected, `${builderClass} → ${expected}`);
    assert.equal(route.geminiReviewerSelection, undefined);
    // off must return the baseRoute untouched.
    assert.deepEqual(route, base);
  }
});

test('GMW-02 fallback: gemini only when the primary reviewer is quota-capped', () => {
  const builderClass = 'claude-code';
  const base = baseRouteFor(builderClass); // primary reviewer = codex

  const notCapped = applyGeminiReviewerRoute({
    builderClass,
    baseRoute: base,
    mode: 'fallback',
    primaryReviewerQuotaCapped: false,
  });
  assert.equal(notCapped.reviewerModel, 'codex', 'primary healthy → keep codex');
  assert.equal(notCapped.geminiReviewerSelection, undefined);

  const capped = applyGeminiReviewerRoute({
    builderClass,
    baseRoute: base,
    mode: 'fallback',
    primaryReviewerQuotaCapped: true,
  });
  assert.equal(capped.reviewerModel, 'gemini', 'primary capped → gemini');
  assert.equal(capped.geminiReviewerSelection.reason, 'primary-reviewer-quota-capped');
});

test('GMW-02 exported route surfaces default to effective always-on Gemini routing', () => {
  for (const builderClass of ['claude-code', 'codex', 'clio-agent']) {
    const subjectRoute = routeSubject({ builderClass }, HERMETIC);
    assert.equal(subjectRoute.reviewerModel, 'gemini', `${builderClass} subject route`);
    assert.equal(subjectRoute.botTokenEnv, 'GH_GEMINI_REVIEWER_TOKEN');
    assert.equal(subjectRoute.geminiReviewerSelection.reason, 'always-on-third-reviewer');

    const prRoute = routePR(`[${builderClass}] LAC-484: effective route`, null, HERMETIC);
    assert.equal(prRoute.reviewerModel, 'gemini', `${builderClass} PR route`);
    assert.equal(prRoute.botTokenEnv, 'GH_GEMINI_REVIEWER_TOKEN');
    assert.equal(prRoute.geminiReviewerSelection.reason, 'always-on-third-reviewer');
  }
});

// ── adversarial integrity hard guard ───────────────────────────────────────

test('GMW-02 integrity: a [gemini] PR is NEVER assigned reviewerModel=gemini', () => {
  for (const mode of ['off', 'fallback', 'always-on']) {
    const route = applyGeminiReviewerRoute({
      builderClass: 'gemini',
      baseRoute: baseRouteFor('gemini'),
      mode,
      primaryReviewerQuotaCapped: true, // even when "capped", never gemini
    });
    assert.notEqual(route.reviewerModel, 'gemini', `mode=${mode} must not pick gemini`);
    assert.equal(route.reviewerModel, 'codex', 'gemini builder keeps its codex reviewer');
  }
});

test('GMW-02 integrity: an operator gemini pin onto a [gemini] PR is stripped', () => {
  // Simulate `roles.reviewer=gemini` producing a gemini base route for a
  // gemini-built PR — the hard guard must fall back to cross-model codex.
  const pinnedBase = {
    builderClass: 'gemini',
    tag: '[gemini]',
    reviewerModel: 'gemini',
    botTokenEnv: 'GH_GEMINI_REVIEWER_TOKEN',
  };
  for (const mode of ['off', 'fallback', 'always-on']) {
    const route = applyGeminiReviewerRoute({
      builderClass: 'gemini',
      baseRoute: pinnedBase,
      mode,
      primaryReviewerQuotaCapped: true,
    });
    assert.equal(route.reviewerModel, 'codex', `mode=${mode}`);
    assert.equal(route.botTokenEnv, 'GH_CODEX_REVIEWER_TOKEN', `mode=${mode}`);
    assert.equal(route.geminiIntegrityGuard.blockedReviewerModel, 'gemini', `mode=${mode}`);
    assert.equal(route.geminiIntegrityGuard.fellBackTo, 'codex', `mode=${mode}`);
  }
});

test('GMW-02 integrity: exported routing helpers strip a gemini pin from [gemini] PRs', () => {
  const pinnedGeminiConfig = () => ({
    get(key, fallback = null) {
      if (key === 'roles.reviewer') return 'gemini';
      if (key === 'linear.issue_prefix') return 'LAC';
      return fallback;
    },
  });

  const subjectRoute = routeSubject(
    { builderClass: 'gemini' },
    { env: {}, loaderImpl: pinnedGeminiConfig },
  );
  assert.equal(subjectRoute.reviewerModel, 'codex');
  assert.equal(subjectRoute.botTokenEnv, 'GH_CODEX_REVIEWER_TOKEN');
  assert.equal(subjectRoute.geminiIntegrityGuard.blockedReviewerModel, 'gemini');
  assert.equal(subjectRoute.geminiIntegrityGuard.fellBackTo, 'codex');

  const prRoute = routePR('[gemini] LAC-484: direct route guard', null, {
    env: { ADVERSARIAL_REVIEW_DEFAULT_REVIEWER: 'gemini' },
    loaderImpl: pinnedGeminiConfig,
  });
  assert.equal(prRoute.reviewerModel, 'codex');
  assert.equal(prRoute.botTokenEnv, 'GH_CODEX_REVIEWER_TOKEN');
  assert.equal(prRoute.geminiIntegrityGuard.blockedReviewerModel, 'gemini');
  assert.equal(prRoute.linearTicketId, 'LAC-484');
});

test('GMW-02 integrity: gemini may review every non-gemini builder, never gemini', () => {
  assert.equal(geminiMayReviewBuilder('claude-code'), true);
  assert.equal(geminiMayReviewBuilder('codex'), true);
  assert.equal(geminiMayReviewBuilder('clio-agent'), true);
  assert.equal(geminiMayReviewBuilder('gemini'), false);
  assert.equal(geminiMayReviewBuilder('unknown-class'), false);
  // gemini is never in the reviewable allowlist.
  assert.ok(!GEMINI_REVIEWABLE_BUILDER_CLASSES.includes('gemini'));
});

test('GMW-02 gemini pinned onto a non-gemini builder is allowed (cross-model)', () => {
  const pinnedBase = {
    builderClass: 'claude-code',
    tag: '[claude-code]',
    reviewerModel: 'gemini',
    botTokenEnv: 'GH_GEMINI_REVIEWER_TOKEN',
  };
  const route = applyGeminiReviewerRoute({
    builderClass: 'claude-code',
    baseRoute: pinnedBase,
    mode: 'always-on',
  });
  assert.equal(route.reviewerModel, 'gemini');
  assert.equal(route.geminiIntegrityGuard, undefined);
});

// ── mode normalization + config cascade ────────────────────────────────────

test('GMW-02 mode normalization defaults only blank/unset to always-on', () => {
  assert.equal(normalizeGeminiReviewerMode('always-on'), 'always-on');
  assert.equal(normalizeGeminiReviewerMode('OFF'), 'off');
  assert.equal(normalizeGeminiReviewerMode(' fallback '), 'fallback');
  assert.equal(normalizeGeminiReviewerMode(''), 'always-on');
  assert.equal(normalizeGeminiReviewerMode(undefined), 'always-on');
  assert.throws(
    () => normalizeGeminiReviewerMode('nonsense'),
    /reviewer\.gemini\.mode must be one of: off, fallback, always-on/i,
  );
});

test('GMW-02 config: default mode is always-on; module file + env override resolve', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'gmw-02-mode-'));
  try {
    // No file pin → schema default.
    const def = resolveGeminiReviewerMode({ env: {}, topPath: '/dev/null', modulePaths: [join(tmp, 'none.yaml')] });
    assert.equal(def, 'always-on');

    const modulePath = join(tmp, 'config.yaml');
    writeFileSync(modulePath, 'reviewer:\n  gemini:\n    mode: fallback\n', 'utf8');
    const fileMode = resolveGeminiReviewerMode({ env: {}, topPath: '/dev/null', modulePaths: [modulePath] });
    assert.equal(fileMode, 'fallback');

    // Env override (legacy alias) beats the module file.
    const envMode = resolveGeminiReviewerMode({
      env: { ADVERSARIAL_REVIEW_GEMINI_REVIEWER_MODE: 'off' },
      topPath: '/dev/null',
      modulePaths: [modulePath],
    });
    assert.equal(envMode, 'off');

    for (const envName of ['AGENT_OS_REVIEWER_GEMINI_MODE', 'ADVERSARIAL_REVIEW_GEMINI_REVIEWER_MODE']) {
      const blankEnvMode = resolveGeminiReviewerMode({
        env: { [envName]: '   ' },
        topPath: '/dev/null',
        modulePaths: [modulePath],
      });
      assert.equal(blankEnvMode, 'fallback');
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('GMW-02 config: a bad mode value fails the strict schema', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'gmw-02-bad-'));
  try {
    const modulePath = join(tmp, 'config.yaml');
    writeFileSync(modulePath, 'reviewer:\n  gemini:\n    mode: sometimes\n', 'utf8');
    assert.throws(
      () => resolveGeminiReviewerMode({ env: {}, topPath: '/dev/null', modulePaths: [modulePath] }),
      /mode|allowlist|always-on/i,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── reviewer-identity maps ─────────────────────────────────────────────────

test('GMW-02 identity: a gemini REVIEW captures against the GitHub App bot login', () => {
  // review-body-capture: reviewer-model key and the reviewer token-env key.
  assert.equal(resolveReviewerBotLogin('gemini'), 'lacey-gemini-reviewer[bot]');
  assert.equal(resolveReviewerBotLogin('GH_GEMINI_REVIEWER_TOKEN'), 'lacey-gemini-reviewer[bot]');
  // reviewer-reattach: reviewer-model key.
  assert.equal(reviewerBotLogin('gemini'), 'gemini-reviewer-lacey');
});

test('GMW-02 identity: builder-side reviewer of a [gemini] PR stays codex-reviewer-lacey', () => {
  // A gemini-built PR routes to the codex reviewer (cross-model). End-to-end
  // that reviewer identity must remain codex-reviewer-lacey — the existing
  // "who reviews a gemini-built PR" mapping is preserved.
  const route = baseRouteFor('gemini');
  assert.equal(route.reviewerModel, 'codex');
  assert.equal(resolveReviewerBotLogin(route.botTokenEnv), 'lacey-codex-reviewer[bot]');
  assert.equal(reviewerBotLogin('codex'), 'codex-reviewer-lacey');
});

// ── reviewer-roster surface (SPEC §1 mockup) ───────────────────────────────

test('GMW-02 roster matches the SPEC §1 capability matrix', () => {
  const roster = reviewerRoster({ mode: 'always-on' });
  const defaultsByModel = Object.fromEntries(roster.map((r) => [r.reviewerModel, r.defaultBuilderClasses]));
  assert.deepEqual(defaultsByModel.claude, []);
  assert.deepEqual(defaultsByModel.codex, ['gemini', 'pi', 'opencode', 'hermes']);
  assert.deepEqual(defaultsByModel.gemini, ['codex', 'claude-code', 'clio-agent']);

  const eligibleByModel = Object.fromEntries(roster.map((r) => [r.reviewerModel, r.eligibleBuilderClasses]));
  assert.deepEqual(eligibleByModel.claude, ['codex', 'clio-agent', 'gemini', 'pi', 'opencode', 'hermes']);
  assert.deepEqual(eligibleByModel.codex, ['claude-code', 'gemini', 'pi', 'opencode', 'hermes']);
  assert.deepEqual(eligibleByModel.gemini, ['codex', 'claude-code', 'clio-agent']);
  // gemini never reviews gemini.
  assert.ok(!defaultsByModel.gemini.includes('gemini'));
  assert.ok(!eligibleByModel.gemini.includes('gemini'));
});

test('GMW-02 roster formatting + gemini note reflects the mode', () => {
  const out = formatReviewerRoster(reviewerRoster({ mode: 'always-on' }));
  assert.match(out, /claude\s+-> default: \[\]; eligible: \[codex, clio-agent, gemini, pi, opencode, hermes\]/);
  assert.match(out, /codex\s+-> default: \[gemini, pi, opencode, hermes\]; eligible: \[claude-code, gemini, pi, opencode, hermes\]/);
  assert.match(out, /gemini\s+-> default: \[codex, claude-code, clio-agent\]; eligible: \[codex, claude-code, clio-agent\]\s+\(always-on, GMW\)/);

  assert.match(
    formatReviewerRoster(reviewerRoster({ mode: 'fallback' })),
    /\(fallback: only when primary reviewer quota-capped, GMW\)/,
  );
  assert.match(formatReviewerRoster(reviewerRoster({ mode: 'off' })), /\(off: not selected, GMW\)/);
});

test('GMW-02 reviewer-roster CLI prints the roster and resolved mode', () => {
  let out = '';
  const rc = reviewerRosterMain([], {
    env: { AGENT_OS_CONFIG_PATH: '/dev/null' },
    stdout: { write: (s) => { out += s; } },
    stderr: { write: () => {} },
  }, HERMETIC);
  assert.equal(rc, 0);
  assert.match(out, /reviewer\.gemini\.mode=/);
  assert.match(out, /gemini\s+-> default: \[codex, claude-code, clio-agent\]; eligible: \[codex, claude-code, clio-agent\]/);
});

test('GMW-02 reviewer-roster CLI --json emits structured roster', () => {
  let out = '';
  const rc = reviewerRosterMain(['--json'], {
    env: { AGENT_OS_CONFIG_PATH: '/dev/null' },
    stdout: { write: (s) => { out += s; } },
    stderr: { write: () => {} },
  }, HERMETIC);
  assert.equal(rc, 0);
  const parsed = JSON.parse(out);
  assert.ok(['off', 'fallback', 'always-on'].includes(parsed.mode));
  const gemini = parsed.roster.find((r) => r.reviewerModel === 'gemini');
  assert.deepEqual(gemini.defaultBuilderClasses, ['codex', 'claude-code', 'clio-agent']);
  assert.deepEqual(gemini.eligibleBuilderClasses, ['codex', 'claude-code', 'clio-agent']);
});

test('GMW-02 docs record the always-on routing contract and hard guard', () => {
  const spec = readFileSync('docs/SPEC-adversarial-review-auto-remediation.md', 'utf8');
  const runbook = readFileSync('docs/follow-up-runbook.md', 'utf8');
  for (const doc of [spec, runbook]) {
    assert.match(doc, /reviewer\.gemini\.mode/);
    assert.match(doc, /default [`"]?always-on[`"]?|default mode is [`"]?always-on[`"]?/i);
    assert.match(doc, /\[codex\].*\[claude-code\].*\[clio-agent\].*Gemini/s);
    assert.match(doc, /GH_GEMINI_REVIEWER_TOKEN/);
    assert.match(doc, /Gemini is never (?:permitted|allowed) to review .*?\[gemini\]/i);
  }
});
