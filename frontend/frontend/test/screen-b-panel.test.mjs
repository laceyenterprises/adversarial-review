/**
 * Screen B renderer tests (ARF-04).
 *
 * The server derives the stop-state; these tests are about the renderer not
 * destroying it. The three ways a panel loses the property are all here: an
 * unknown drawn as an off, a path drawn out of existence, and a banner that
 * disagrees with the payload it was handed.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ageText,
  onOffText,
  renderScreenB,
  renderScreenBPage,
  renderScreenBText,
  stopStateHeadline,
  valueText,
} from '../src/screen-b/panel.mjs';

function key(id, label, { value = true, known = true, killSwitch = false } = {}) {
  return {
    id, key: `roles.adversarial.merge_authority.${label}`, label, killSwitch, note: `about ${label}`,
    value: known ? value : null, known, source: known ? 'file' : null, sourcePath: null,
    setIn: [], caveats: [], type: 'boolean', group: 'merge-authority',
  };
}

function path(id, { state = 'armed', effective = 'merging-possible', msm = true } = {}) {
  return {
    id,
    label: id,
    msm,
    role: `${id} role`,
    executor: { id: 'watcher', job: 'adversarial-watcher', state: 'up' },
    armed: state === 'armed' ? true : state === 'disarmed' ? false : null,
    state,
    armReason: null,
    requirements: [{
      keyId: 'enabled', key: 'roles.adversarial.merge_authority.enabled', label: 'enabled',
      value: true, known: true, expected: true, verdict: 'satisfied', reason: null,
    }],
    disarmedBy: [],
    modifiers: [],
    adoption: { state: 'not-applicable', reason: null },
    effective: { state: effective, reasons: [`${id} reason`] },
  };
}

function payload(over = {}) {
  return {
    generatedAt: '2026-08-19T12:00:00.000Z',
    daemons: [
      { id: 'watcher', label: 'watcher', job: 'adversarial-watcher', state: 'up', ageMs: 12_000, mergeCapable: true, reason: null },
      { id: 'followUp', label: 'follow-up', job: 'adversarial-follow-up', state: 'unknown', ageMs: null, mergeCapable: false, reason: 'no source' },
      { id: 'autoMerge', label: 'auto-merge', job: 'auto-merge-daemon', state: 'up', ageMs: 9_000, mergeCapable: true, reason: null },
    ],
    mergePaths: [path('hammer'), path('daemon-clean'), path('python-backstop', { msm: false })],
    stopState: {
      state: 'merging-possible',
      mergingPaths: ['hammer', 'daemon-clean', 'python-backstop'],
      stoppedPaths: [], unknownPaths: [],
      armedPaths: ['hammer', 'daemon-clean'], disarmedPaths: [], unknownArmPaths: [],
      msmPaths: ['hammer', 'daemon-clean'],
      reasons: ['hammer, daemon-clean can still merge'],
    },
    killSwitches: [
      {
        keyId: 'enabled', key: 'roles.adversarial.merge_authority.enabled', label: 'enabled',
        value: true, known: true, source: 'file', env: 'AGENT_OS_X', caveats: [],
        governs: ['hammer', 'daemon-clean'], doesNotGovern: ['python-backstop'], disarming: [],
        note: 'master switch',
      },
      {
        keyId: 'autonomousMergeExecutionEnabled',
        key: 'roles.adversarial.merge_authority.autonomous_merge_execution_enabled',
        label: 'autonomous_merge_execution_enabled',
        value: true, known: true, source: 'file', env: 'AGENT_OS_Y', caveats: [],
        governs: ['hammer', 'daemon-clean'], doesNotGovern: ['python-backstop'], disarming: [],
        note: 'execution kill switch',
      },
    ],
    governance: {
      sources: [{ path: '/p/config.yaml', label: 'module', present: true, readable: true, modifiedAt: null, reason: null }],
      configChangedAt: '2026-08-19T11:00:00.000Z',
      envLayer: { observable: false, source: null, reason: 'cannot read another process environment' },
      keys: {
        enabled: key('enabled', 'enabled', { killSwitch: true }),
        autonomousMergeExecutionEnabled: key('autonomousMergeExecutionEnabled', 'autonomous_merge_execution_enabled', { killSwitch: true }),
        strictMode: key('strictMode', 'strict_mode'),
        strictNonBlockingRemediation: key('strictNonBlockingRemediation', 'strict_non_blocking_remediation'),
        hammerLifetimeCeiling: key('hammerLifetimeCeiling', 'hammer_lifetime_ceiling', { value: 6 }),
        branchProtectionRequired: key('branchProtectionRequired', 'branch_protection.required', { value: false }),
      },
      allKeys: {},
      anySourceReadable: true,
    },
    reviewCycle: {
      cap: 4, capSource: 'file', capKnown: true, windowHours: 24, windowSource: 'file',
      rows: [{
        prUrl: 'https://github.com/o/r/pull/1', repo: 'o/r', pr: 1, headSha: 'abcdef1234',
        headShaShort: 'abcdef1', used: 3, cap: 4, remaining: 1, ageMs: 1000, windowHours: 24,
        windowExpired: false, exhausted: false, escalated: false, escalatedAt: null,
        lastVerdictAt: '2026-08-19T11:59:00Z',
      }],
      total: 1, exhaustedCount: 0, lastRoundCount: 1, unknownCount: 0,
      store: { available: true },
    },
    store: { available: true },
    ...over,
  };
}

describe('value rendering', () => {
  it('keeps unknown distinct from false', () => {
    // The collapse that turns a governance panel into a liar.
    assert.equal(valueText({ known: true, value: false }), 'false');
    assert.equal(valueText({ known: false, value: null }), 'unknown');
    assert.equal(valueText(undefined), 'unknown');
    assert.equal(onOffText({ known: true, value: false }), 'off');
    assert.equal(onOffText({ known: false, value: null }), 'unknown');
  });

  it('draws "stop not proven" differently from "stopped"', () => {
    assert.match(stopStateHeadline({ state: 'stopped' }), /^STOPPED/);
    assert.match(stopStateHeadline({ state: 'unknown' }), /^STOP NOT PROVEN/);
    assert.match(
      stopStateHeadline({ state: 'merging-possible', mergingPaths: ['hammer'] }),
      /^MERGES POSSIBLE/,
    );
  });

  it('formats heartbeat ages, and omits one it does not have', () => {
    assert.equal(ageText({ ageMs: 12_000 }), '12s ago');
    assert.equal(ageText({ ageMs: 20 * 60_000 }), '20m ago');
    assert.equal(ageText({ ageMs: 3 * 3600_000 }), '3h ago');
    assert.equal(ageText({ ageMs: null }), null);
  });
});

describe('HTML panel', () => {
  it('draws every merge path and both kill-switch keys', () => {
    const html = renderScreenB(payload());
    for (const id of ['hammer', 'daemon-clean', 'python-backstop']) {
      assert.match(html, new RegExp(`data-path="${id}"`), `${id} must be drawn`);
    }
    assert.match(html, /data-kill-switch="enabled"/);
    assert.match(html, /data-kill-switch="autonomousMergeExecutionEnabled"/);
    assert.match(html, /roles\.adversarial\.merge_authority\.enabled/);
    assert.match(html, /roles\.adversarial\.merge_authority\.autonomous_merge_execution_enabled/);
  });

  it('shows which merge-capable paths a kill switch does NOT govern', () => {
    // Without this column, "both switches off" reads as "the pipeline is
    // stopped" while the Python backstop keeps merging.
    const html = renderScreenB(payload());
    assert.match(html, /does NOT govern/);
    assert.match(html, /<td class="warn">python-backstop<\/td>/);
  });

  it('renders a disarmed path as disarmed and an unknown one as unknown', () => {
    const html = renderScreenB(payload({
      mergePaths: [
        path('hammer', { state: 'disarmed', effective: 'unknown' }),
        path('daemon-clean', { state: 'unknown', effective: 'unknown' }),
        path('python-backstop', { state: 'armed', msm: false }),
      ],
    }));
    assert.match(html, /data-path="hammer" data-state="disarmed"/);
    assert.match(html, /data-path="daemon-clean" data-state="unknown"/);
    assert.match(html, /data-path="python-backstop" data-state="armed"/);
  });

  it('renders an unresolved key as unknown, never as false', () => {
    const state = payload();
    state.governance.keys.enabled = key('enabled', 'enabled', { known: false, killSwitch: true });
    const html = renderScreenB(state);
    assert.match(html, /<td class="key__value" data-value="unknown">unknown<\/td>/);
    assert.ok(!/data-value="false"[^>]*>false<\/td>\s*<td class="key__source">unresolved/.test(html));
  });

  it('draws the banner from the payload aggregate, not from the rows', () => {
    // A renderer that recomputed the aggregate is a second implementation of
    // the stop-state, and two implementations disagree eventually.
    const state = payload({
      stopState: {
        state: 'unknown', mergingPaths: [], stoppedPaths: [], unknownPaths: ['hammer'],
        armedPaths: [], disarmedPaths: [], unknownArmPaths: [], msmPaths: [],
        reasons: ['a reason'],
      },
    });
    const html = renderScreenB(state);
    assert.match(html, /data-stop-state="unknown"/);
    assert.match(html, /STOP NOT PROVEN/);
    // …even though every path row still says armed.
    assert.match(html, /data-state="armed"/);
  });

  it('surfaces an unobservable environment layer as a warning', () => {
    assert.match(renderScreenB(payload()), /Environment layer not observable/);
  });

  it('escapes payload text into HTML', () => {
    const state = payload();
    state.governance.sources[0].path = '/p/<script>alert(1)</script>.yaml';
    const html = renderScreenB(state);
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.match(html, /&lt;script&gt;/);
  });

  it('marks arm/disarm as not available in this ticket', () => {
    // SPEC §5: the UI arms and disarms in ARF-08; ARF-04 is a read surface, and
    // a live-looking button that does nothing is its own kind of misreport.
    const html = renderScreenB(payload());
    assert.match(html, /<button type="button" disabled[^>]*>Arm<\/button>/);
    assert.match(html, /Disarm \(emergency stop\)/);
    assert.match(html, /ARF-08/);
  });

  it('wraps the panel in a self-contained document', () => {
    const page = renderScreenBPage(payload());
    assert.match(page, /^<!doctype html>/);
    assert.match(page, /<meta http-equiv="refresh" content="15">/);
    assert.ok(!/<script/.test(page), 'the page needs no client-side renderer');
    assert.equal(renderScreenBPage(payload(), { refreshMs: 0 }).includes('http-equiv="refresh"'), false);
  });
});

describe('text panel', () => {
  it('matches the SPEC Screen B shape and stays inside its box', () => {
    const text = renderScreenBText(payload());
    const widths = new Set(text.split('\n').map((line) => [...line].length));
    assert.equal(widths.size, 1, `panel lines must share one width, got ${[...widths]}`);
    assert.match(text, /^┌ Pipeline /);
    assert.match(text, /MSM paths:\s+hammer ▸ armed\s+daemon-clean ▸ armed/);
    assert.match(text, /kill-switch: enabled=true\s+autonomous_merge_execution_enabled=true/);
    assert.match(text, /strict_non_blocking_remediation=on/);
    assert.match(text, /cycle cap:\s+4 over 24h/);
  });

  it('names the non-MSM path on its own line rather than dropping it', () => {
    assert.match(renderScreenBText(payload()), /also:\s+python-backstop/);
  });

  it('spells out an unknown key instead of leaving a blank', () => {
    const state = payload();
    state.governance.keys.autonomousMergeExecutionEnabled = key(
      'autonomousMergeExecutionEnabled', 'autonomous_merge_execution_enabled',
      { known: false, killSwitch: true },
    );
    assert.match(renderScreenBText(state), /autonomous_merge_execution_enabled=unknown/);
  });

  it('wraps a long stop-state reason rather than truncating it', () => {
    const state = payload({
      stopState: {
        state: 'unknown', mergingPaths: [], stoppedPaths: [], unknownPaths: ['daemon-clean'],
        armedPaths: [], disarmedPaths: ['daemon-clean'], unknownArmPaths: [], msmPaths: [],
        reasons: ['the config disarms this path, but a live daemon caches config and '
          + 'environment at boot, so a flip is not proven to be in effect'],
      },
    });
    const text = renderScreenBText(state);
    assert.ok(!text.includes('...'), 'a reason must not be truncated');
    assert.match(text, /not proven to be in effect/);
  });
});
