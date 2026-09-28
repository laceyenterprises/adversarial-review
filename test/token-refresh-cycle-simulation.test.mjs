// TOKDZ-01 — simulate the Claude OAuth token cycle that produced the SEV3
// (agent-os #7309) and prove the dead zone is gone.
//
// The model, from the evidence record:
//   - a Claude OAuth token lives 8 h;
//   - the keychain bridge rotates it once fewer than `refresh_window_seconds`
//     (1800 s) remain, minting a fresh 8 h token and revoking the old one;
//   - the broker serves whichever token is current;
//   - the largest reviewer pass has a 180 min ceiling (the live refusal read
//     minimum=10919571ms: 180 min + 2 min post slack, minus elapsed budget).
// Every simulated minute a Claude reviewer is picked and runs the REAL handoff
// check. A refusal feeds the REAL refusal message through the REAL hold logic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { __test__ as harness } from '../src/reviewer-harness.mjs';
import { CLAUDE_REVIEWER_PROXIED_HANDOFF_FLOOR_MS } from '../src/claude-reviewer-token-proxy.mjs';
import {
  computeTokenRefreshHold,
  parseTokenRefreshRefusal,
  resolveTokenRefreshHoldConfig,
  tokenRefreshHoldExhausted,
} from '../src/token-refresh-hold.mjs';

const { assertClaudeBrokerTokenHandoffLifetime } = harness;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const TOKEN_LIFETIME_MS = 8 * HOUR;
const BRIDGE_REFRESH_WINDOW_MS = 30 * MINUTE;
const MAX_REVIEWER_CEILING_MS = 180 * MINUTE;
const SIMULATED_MS = 24 * HOUR; // three full cycles
const T0 = Date.parse('2026-09-28T00:00:00Z');
// The acceptance bound: no refusal window may last longer than the proxied
// handoff floor, even when the bridge rotates at the last possible moment.
const REFUSAL_WINDOW_BOUND_MS = CLAUDE_REVIEWER_PROXIED_HANDOFF_FLOOR_MS;
const HOLD_CONFIG = resolveTokenRefreshHoldConfig({});

// The broker's current token at `nowMs`, for a bridge that rotates once
// `rotateAtRemainingMs` of life is left.
function brokerTokenAt(nowMs, { rotateAtRemainingMs = BRIDGE_REFRESH_WINDOW_MS } = {}) {
  const rotationPeriodMs = TOKEN_LIFETIME_MS - rotateAtRemainingMs;
  const issuedAtMs = T0 + Math.floor((nowMs - T0) / rotationPeriodMs) * rotationPeriodMs;
  return { expiresAt: new Date(issuedAtMs + TOKEN_LIFETIME_MS).toISOString() };
}

function pick(nowMs, { proxied, rotateAtRemainingMs }) {
  try {
    assertClaudeBrokerTokenHandoffLifetime({
      expiresAt: brokerTokenAt(nowMs, { rotateAtRemainingMs }).expiresAt,
      nowMs,
      reviewerTimeoutMs: MAX_REVIEWER_CEILING_MS,
      proxied,
    });
    return null;
  } catch (err) {
    assert.equal(err.failureClass, 'token-refresh-pending');
    return err.message;
  }
}

function simulate({ proxied, rotateAtRemainingMs = BRIDGE_REFRESH_WINDOW_MS }) {
  let longestMs = 0;
  let runStartMs = null;
  let refusedMinutes = 0;
  for (let nowMs = T0; nowMs <= T0 + SIMULATED_MS; nowMs += MINUTE) {
    if (pick(nowMs, { proxied, rotateAtRemainingMs })) {
      refusedMinutes += 1;
      if (runStartMs === null) runStartMs = nowMs;
      longestMs = Math.max(longestMs, nowMs - runStartMs + MINUTE);
    } else {
      runStartMs = null;
    }
  }
  return { longestMs, refusedMinutes };
}

test('proxied handoff: a healthy 8 h cycle has no refusal window at all', () => {
  const { longestMs, refusedMinutes } = simulate({ proxied: true });
  assert.equal(refusedMinutes, 0);
  assert.equal(longestMs, 0);
});

test('proxied handoff: even a bridge that rotates only at expiry keeps every refusal window within the bound', () => {
  for (const rotateAtRemainingMs of [20 * MINUTE, 10 * MINUTE, 5 * MINUTE, 1 * MINUTE, 0]) {
    const { longestMs } = simulate({ proxied: true, rotateAtRemainingMs });
    assert.ok(
      longestMs <= REFUSAL_WINDOW_BOUND_MS,
      `rotation at ${rotateAtRemainingMs / MINUTE} min left: refusal window ${longestMs / MINUTE} min exceeds the bound`,
    );
  }
});

test('direct handoff (the pre-TOKDZ-01 behaviour) reproduces the ~2.5 h dead zone per cycle', () => {
  const { longestMs, refusedMinutes } = simulate({ proxied: false });
  // Refused from 182 min of life left down to the 30 min rotation point.
  assert.ok(longestMs >= 150 * MINUTE && longestMs <= 153 * MINUTE, `longest=${longestMs / MINUTE} min`);
  // Three cycles of that is ~31% of the day, as the SEV3 measured.
  assert.ok(refusedMinutes / (SIMULATED_MS / MINUTE) > 0.3);
  assert.ok(longestMs > REFUSAL_WINDOW_BOUND_MS);
});

// Even with the proxy disabled, hold accounting bounds how long any one PR
// waits: it is held (never charged) until the rotation or the hold bound, then
// re-routed. Walk a PR picked at every minute of the direct-handoff dead zone.
test('direct handoff: every PR caught in the dead zone waits at most the hold bound, then re-routes', () => {
  let worstWaitMs = 0;
  let pickedInDeadZone = 0;
  for (let firstPickMs = T0; firstPickMs < T0 + 8 * HOUR; firstPickMs += 5 * MINUTE) {
    let nowMs = firstPickMs;
    let hold = null;
    let refusals = 0;
    for (;;) {
      if (tokenRefreshHoldExhausted(hold, { reviewerModel: 'claude', nowMs, config: HOLD_CONFIG })) break; // re-routed
      const refusal = pick(nowMs, { proxied: false });
      if (!refusal) break; // Claude reviews
      refusals += 1;
      hold = computeTokenRefreshHold({
        previousHold: hold,
        failureAtMs: nowMs,
        floorMs: nowMs + MINUTE,
        refusal: parseTokenRefreshRefusal(`[token-refresh-pending] ${refusal}`),
        reviewerModel: 'claude',
        config: HOLD_CONFIG,
      });
      assert.equal(hold.refusals, refusals);
      nowMs = Date.parse(hold.holdUntil); // the cascade gate re-opens here
      assert.ok(refusals < 100, 'a hold must not tight-loop');
    }
    if (refusals > 0) pickedInDeadZone += 1;
    worstWaitMs = Math.max(worstWaitMs, nowMs - firstPickMs);
  }
  assert.ok(pickedInDeadZone > 0);
  assert.ok(
    worstWaitMs <= HOLD_CONFIG.maxHoldMs,
    `worst wait ${worstWaitMs / MINUTE} min exceeds the ${HOLD_CONFIG.maxHoldMs / MINUTE} min hold bound`,
  );
});

test('a refusal near the rotation holds only until the rotation, not the full bound', () => {
  // 40 min before expiry the rotation is 10 min out: well inside the bound.
  const expiresAtMs = T0 + TOKEN_LIFETIME_MS;
  const failureAtMs = expiresAtMs - 40 * MINUTE;
  let message = null;
  try {
    assertClaudeBrokerTokenHandoffLifetime({
      expiresAt: new Date(expiresAtMs).toISOString(),
      nowMs: failureAtMs,
      reviewerTimeoutMs: MAX_REVIEWER_CEILING_MS,
    });
  } catch (err) {
    message = err.message;
  }
  assert.ok(message);
  const hold = computeTokenRefreshHold({
    failureAtMs,
    floorMs: failureAtMs + MINUTE,
    refusal: parseTokenRefreshRefusal(message),
    config: HOLD_CONFIG,
  });
  assert.equal(hold.expectedRotationAt, new Date(expiresAtMs - BRIDGE_REFRESH_WINDOW_MS).toISOString());
  assert.equal(Date.parse(hold.holdUntil) - failureAtMs, 11 * MINUTE);
  // After the rotation the next pick is a fresh 8 h token and passes.
  assert.equal(pick(Date.parse(hold.holdUntil), { proxied: false }), null);
});
