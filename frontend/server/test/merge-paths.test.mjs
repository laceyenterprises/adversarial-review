/**
 * The ARF-04 acceptance tests: the stop-state can never be misreported.
 *
 * Every case here is a state the live pipeline can actually be in, and the
 * assertions are about the two failure directions:
 *
 *   - reporting a path `armed` when its governing config disarms it, and
 *   - reporting the pipeline `stopped` when something can still merge.
 *
 * The second is the dangerous one (2026-07-26: two config-flag halts plus
 * bounces did not stop live merges), so the exhaustive case at the bottom
 * enumerates the whole input space and asserts `stopped` is only ever reached
 * from positive evidence.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { GOVERNANCE_KEYS, MSM_PATH_IDS } from '../src/governance/keys.mjs';
import { deriveMergePaths } from '../src/governance/merge-paths.mjs';

/**
 * Resolved-key fixtures. `undefined` for a key means "ARF could not establish
 * it" — the tri-state's third leg, and the one a naive panel collapses.
 */
function keys(values = {}) {
  const resolved = {};
  for (const entry of Object.values(GOVERNANCE_KEYS)) {
    const value = Object.prototype.hasOwnProperty.call(values, entry.id)
      ? values[entry.id]
      : entry.default;
    resolved[entry.id] = {
      ...entry,
      schemaDefault: entry.default,
      value: value === undefined ? null : value,
      known: value !== undefined,
      source: value === undefined ? null : 'file',
      sourcePath: value === undefined ? null : '/fixture/config.yaml',
      setIn: [],
      caveats: [],
      reason: value === undefined ? 'value not established' : null,
    };
  }
  return resolved;
}

function daemons({ watcher = 'up', autoMerge = 'up', followUp = 'up' } = {}) {
  const make = (id, job, state, mergeCapable) => ({
    id, job, label: id, state, mergeCapable, ageMs: 0, lastBeatAt: null, reason: null,
  });
  return {
    watcher: make('watcher', 'adversarial-watcher', watcher, true),
    followUp: make('followUp', 'adversarial-follow-up', followUp, false),
    autoMerge: make('autoMerge', 'auto-merge-daemon', autoMerge, true),
  };
}

const byId = (result) => Object.fromEntries(result.paths.map((path) => [path.id, path]));

describe('MSM merge-path derivation', () => {
  it('represents both MSM paths and both kill-switch keys distinctly', () => {
    const result = deriveMergePaths({ keys: keys(), daemons: daemons() });
    const paths = byId(result);

    // Both paths, as separate objects with separate arm states.
    assert.deepEqual(MSM_PATH_IDS, ['hammer', 'daemon-clean']);
    assert.ok(paths.hammer, 'the hammer path must be represented');
    assert.ok(paths['daemon-clean'], 'the daemon-clean path must be represented');
    assert.notEqual(paths.hammer, paths['daemon-clean']);

    // Both keys, as separate kill-switch entries. A panel that merged them
    // would have one row here.
    const switches = Object.fromEntries(result.killSwitches.map((entry) => [entry.keyId, entry]));
    assert.deepEqual(
      Object.keys(switches).sort(),
      ['autonomousMergeExecutionEnabled', 'enabled'],
    );
    assert.equal(switches.enabled.key, 'roles.adversarial.merge_authority.enabled');
    assert.equal(
      switches.autonomousMergeExecutionEnabled.key,
      'roles.adversarial.merge_authority.autonomous_merge_execution_enabled',
    );

    // Each MSM path names BOTH keys among its requirements, so neither key can
    // be the only thing a path is read through.
    for (const id of MSM_PATH_IDS) {
      const required = paths[id].requirements.map((req) => req.keyId);
      assert.ok(required.includes('enabled'), `${id} must be governed by enabled`);
      assert.ok(
        required.includes('autonomousMergeExecutionEnabled'),
        `${id} must be governed by autonomous_merge_execution_enabled`,
      );
    }
  });

  it('renders the daemon-clean path disarmed when autonomous execution is off but enabled is on', () => {
    // The headline case: the autonomous-execution key silently wins.
    const result = deriveMergePaths({
      keys: keys({ enabled: true, autonomousMergeExecutionEnabled: false }),
      daemons: daemons(),
    });
    const paths = byId(result);

    assert.equal(paths['daemon-clean'].armed, false);
    assert.equal(paths['daemon-clean'].state, 'disarmed');
    assert.deepEqual(
      paths['daemon-clean'].disarmedBy,
      ['roles.adversarial.merge_authority.autonomous_merge_execution_enabled'],
    );

    // And the hammer, which shares both keys, is disarmed by the same flip —
    // the runbook is explicit that the closer refuses on BOTH sub-paths.
    assert.equal(paths.hammer.armed, false);

    // The key that is still `true` must not be reported as disarming anything.
    const enabledSwitch = result.killSwitches.find((entry) => entry.keyId === 'enabled');
    assert.equal(enabledSwitch.value, true);
    assert.deepEqual(enabledSwitch.disarming, []);
  });

  it('renders both MSM paths armed on a fully-enabled config', () => {
    const result = deriveMergePaths({
      keys: keys({ enabled: true, autonomousMergeExecutionEnabled: true }),
      daemons: daemons(),
    });
    const paths = byId(result);
    assert.equal(paths.hammer.armed, true);
    assert.equal(paths.hammer.state, 'armed');
    assert.equal(paths['daemon-clean'].armed, true);
    assert.equal(paths['daemon-clean'].state, 'armed');
    assert.equal(result.stopState.state, 'merging-possible');
  });

  it('renders both MSM paths disarmed on a fully-disabled config', () => {
    const result = deriveMergePaths({
      keys: keys({ enabled: false, autonomousMergeExecutionEnabled: false }),
      daemons: daemons(),
    });
    const paths = byId(result);
    assert.equal(paths.hammer.armed, false);
    assert.equal(paths['daemon-clean'].armed, false);
    assert.deepEqual(result.stopState.armedPaths.filter((id) => MSM_PATH_IDS.includes(id)), []);
  });

  it('disarms the hammer when its lifetime ceiling is zero, without touching the daemon path', () => {
    // `hammer_lifetime_ceiling: 0` disables the hammer path outright. A panel
    // reading only the two kill-switch keys would call it armed.
    const result = deriveMergePaths({
      keys: keys({
        enabled: true, autonomousMergeExecutionEnabled: true, hammerLifetimeCeiling: 0,
      }),
      daemons: daemons(),
    });
    const paths = byId(result);
    assert.equal(paths.hammer.armed, false);
    assert.deepEqual(
      paths.hammer.disarmedBy,
      ['roles.adversarial.merge_authority.hammer_lifetime_ceiling'],
    );
    assert.equal(paths['daemon-clean'].armed, true);
  });

  it('treats strict_mode as a modifier, never as an arm input', () => {
    // strict_mode narrows what the daemon path may merge. Folding it into the
    // arm decision would render a running pipeline as stopped.
    for (const strictMode of [true, false]) {
      const result = deriveMergePaths({
        keys: keys({ enabled: true, autonomousMergeExecutionEnabled: true, strictMode }),
        daemons: daemons(),
      });
      const path = byId(result)['daemon-clean'];
      assert.equal(path.armed, true, `strict_mode=${strictMode} must not disarm the path`);
      assert.ok(
        !path.requirements.some((req) => req.keyId === 'strictMode'),
        'strict_mode must not appear among the arm requirements',
      );
      assert.ok(
        path.modifiers.some((mod) => mod.keyId === 'strictMode' && mod.value === strictMode),
        'strict_mode must appear as a modifier',
      );
    }
  });

  it('reports an unestablished key as unknown, not as disarmed', () => {
    const result = deriveMergePaths({
      keys: keys({ enabled: undefined, autonomousMergeExecutionEnabled: true }),
      daemons: daemons(),
    });
    const path = byId(result)['daemon-clean'];
    assert.equal(path.armed, null);
    assert.equal(path.state, 'unknown');
    assert.match(path.armReason, /could not establish/);
    assert.notEqual(result.stopState.state, 'stopped');
  });

  it('lets a known disarming key win over an unknown one', () => {
    // "Some other key might also be off" never makes a path more armed, so a
    // definite `false` still disarms while a sibling key is unreadable.
    const result = deriveMergePaths({
      keys: keys({ enabled: undefined, autonomousMergeExecutionEnabled: false }),
      daemons: daemons(),
    });
    const path = byId(result)['daemon-clean'];
    assert.equal(path.armed, false);
    assert.deepEqual(
      path.disarmedBy,
      ['roles.adversarial.merge_authority.autonomous_merge_execution_enabled'],
    );
  });
});

describe('the Python auto-merge backstop', () => {
  it('is carried as its own path that neither kill-switch key governs', () => {
    const result = deriveMergePaths({ keys: keys(), daemons: daemons() });
    const backstop = byId(result)['python-backstop'];
    assert.ok(backstop, 'the auto-merge backstop must be represented');
    assert.equal(backstop.msm, false);
    assert.deepEqual(backstop.requirements, []);
    // Flagged, so "no requirements failed" is never mistaken for "every
    // requirement passed" by a consumer counting requirement verdicts.
    assert.equal(backstop.armedByLiveness, true);
    assert.equal(byId(result).hammer.armedByLiveness, false);

    for (const entry of result.killSwitches) {
      assert.ok(
        entry.doesNotGovern.includes('python-backstop'),
        `${entry.key} must be reported as NOT governing the backstop`,
      );
    }
  });

  it('stays armed while its daemon beats, even with both kill switches off', () => {
    // The trap this ticket exists for: turning both keys off disarms both MSM
    // paths while the Python backstop keeps merging — and `enabled: false`
    // actually removes its deferral to the AMA closer, so it merges sooner.
    const result = deriveMergePaths({
      keys: keys({ enabled: false, autonomousMergeExecutionEnabled: false }),
      daemons: daemons({ watcher: 'down', autoMerge: 'up' }),
    });
    const paths = byId(result);
    assert.equal(paths.hammer.armed, false);
    assert.equal(paths['daemon-clean'].armed, false);
    assert.equal(paths['python-backstop'].armed, true);

    assert.equal(result.stopState.state, 'merging-possible');
    assert.deepEqual(result.stopState.mergingPaths, ['python-backstop']);
  });

  it('is unknown, not disarmed, when its daemon has no liveness signal', () => {
    const result = deriveMergePaths({
      keys: keys({ enabled: false, autonomousMergeExecutionEnabled: false }),
      daemons: daemons({ watcher: 'down', autoMerge: 'unknown' }),
    });
    assert.equal(byId(result)['python-backstop'].armed, null);
    assert.equal(result.stopState.state, 'unknown');
  });
});

describe('effective stop-state', () => {
  it('refuses to call a config flip a stop while the daemon is still live', () => {
    // The daemon caches config and environment at boot; a flip is not a stop
    // until it has been bounced.
    const result = deriveMergePaths({
      keys: keys({ enabled: false, autonomousMergeExecutionEnabled: false }),
      daemons: daemons({ watcher: 'up', autoMerge: 'down' }),
    });
    const path = byId(result)['daemon-clean'];
    assert.equal(path.armed, false, 'the config does disarm it');
    assert.equal(path.effective.state, 'unknown', 'but the stop is not proven');
    assert.equal(path.adoption.state, 'unproven');
    assert.ok(path.effective.reasons.some((reason) => /bounce/.test(reason)));
    assert.equal(result.stopState.state, 'unknown');
  });

  it('calls it stopped once the disarming config and a dead executor agree', () => {
    const result = deriveMergePaths({
      keys: keys({ enabled: false, autonomousMergeExecutionEnabled: false }),
      daemons: daemons({ watcher: 'down', autoMerge: 'down' }),
    });
    assert.equal(result.stopState.state, 'stopped');
    assert.deepEqual(result.stopState.mergingPaths, []);
    assert.equal(result.stopState.stoppedPaths.length, 3);
  });

  it('accepts a restart that post-dates the config change as adoption', () => {
    // ARF-08's supervisor knows when it started a process. When that evidence
    // exists, a disarming flip over a live daemon IS a proven stop.
    const probes = daemons({ watcher: 'up', autoMerge: 'down' });
    probes.watcher.startedAt = '2026-08-19T12:00:00Z';
    const result = deriveMergePaths({
      keys: keys({ enabled: false, autonomousMergeExecutionEnabled: false }),
      daemons: probes,
      envLayerObservable: true,
      configChangedAt: '2026-08-19T11:00:00Z',
    });
    const path = byId(result)['daemon-clean'];
    assert.equal(path.adoption.state, 'adopted');
    assert.equal(path.effective.state, 'stopped');
    assert.equal(result.stopState.state, 'stopped');
  });

  it('withholds adoption when the daemon restarted before the config changed', () => {
    const probes = daemons({ watcher: 'up', autoMerge: 'down' });
    probes.watcher.startedAt = '2026-08-19T10:00:00Z';
    const result = deriveMergePaths({
      keys: keys({ enabled: false, autonomousMergeExecutionEnabled: false }),
      daemons: probes,
      envLayerObservable: true,
      configChangedAt: '2026-08-19T11:00:00Z',
    });
    const path = byId(result)['daemon-clean'];
    assert.equal(path.adoption.state, 'pending-bounce');
    assert.equal(path.effective.state, 'unknown');
  });

  it('withholds adoption while the environment layer is unobservable', () => {
    // A plist-pinned env var outranks every YAML file, so a restart alone does
    // not prove a file flip took effect.
    const probes = daemons({ watcher: 'up', autoMerge: 'down' });
    probes.watcher.startedAt = '2026-08-19T12:00:00Z';
    const result = deriveMergePaths({
      keys: keys({ enabled: false, autonomousMergeExecutionEnabled: false }),
      daemons: probes,
      envLayerObservable: false,
      configChangedAt: '2026-08-19T11:00:00Z',
    });
    const path = byId(result)['daemon-clean'];
    assert.equal(path.adoption.state, 'unproven');
    assert.match(path.adoption.reason, /environment layer/);
    assert.equal(path.effective.state, 'unknown');
  });

  it('keeps an armed path armed while its executor is momentarily down', () => {
    // A down daemon under launchd KeepAlive comes back with the same config.
    // Reporting an armed path as stopped because it is not ticking right now
    // would be the over-report in the other direction.
    const result = deriveMergePaths({
      keys: keys({ enabled: true, autonomousMergeExecutionEnabled: true }),
      daemons: daemons({ watcher: 'down' }),
    });
    const path = byId(result).hammer;
    assert.equal(path.armed, true);
    assert.equal(path.effective.state, 'merging-possible');
    assert.ok(path.effective.reasons.some((reason) => /merges resume/.test(reason)));
  });
});

describe('no state combination is misreported', () => {
  const BOOLEANS = [true, false, undefined];
  const CEILINGS = [6, 0, undefined];
  const DAEMON_STATES = ['up', 'stale', 'down', 'unknown'];

  it('only reports armed when every governing input is known and satisfied', () => {
    for (const enabled of BOOLEANS) {
      for (const autonomousMergeExecutionEnabled of BOOLEANS) {
        for (const hammerLifetimeCeiling of CEILINGS) {
          for (const watcher of DAEMON_STATES) {
            const resolved = keys({
              enabled, autonomousMergeExecutionEnabled, hammerLifetimeCeiling,
            });
            const result = deriveMergePaths({
              keys: resolved,
              daemons: daemons({ watcher }),
            });
            const label = `enabled=${enabled} auto=${autonomousMergeExecutionEnabled} `
              + `ceiling=${hammerLifetimeCeiling} watcher=${watcher}`;

            for (const path of result.paths) {
              if (path.armedByLiveness) continue;
              if (path.armed !== true) continue;
              for (const req of path.requirements) {
                assert.equal(req.verdict, 'satisfied', `${path.id} armed with ${req.key} ${req.verdict} — ${label}`);
              }
            }

            const hammer = byId(result).hammer;
            const expectedHammerArmed = enabled === true
              && autonomousMergeExecutionEnabled === true
              && hammerLifetimeCeiling === 6;
            if (expectedHammerArmed) {
              assert.equal(hammer.armed, true, `hammer should be armed — ${label}`);
            } else {
              assert.notEqual(hammer.armed, true, `hammer must not be armed — ${label}`);
            }

            const daemonClean = byId(result)['daemon-clean'];
            const expectedDaemonArmed = enabled === true && autonomousMergeExecutionEnabled === true;
            assert.equal(
              daemonClean.armed === true,
              expectedDaemonArmed,
              `daemon-clean arm state wrong — ${label}`,
            );
          }
        }
      }
    }
  });

  it('never reports stopped while any path can still merge', () => {
    for (const enabled of BOOLEANS) {
      for (const autonomousMergeExecutionEnabled of BOOLEANS) {
        for (const watcher of DAEMON_STATES) {
          for (const autoMerge of DAEMON_STATES) {
            const result = deriveMergePaths({
              keys: keys({ enabled, autonomousMergeExecutionEnabled }),
              daemons: daemons({ watcher, autoMerge }),
            });
            const label = `enabled=${enabled} auto=${autonomousMergeExecutionEnabled} `
              + `watcher=${watcher} autoMerge=${autoMerge}`;

            if (result.stopState.state === 'stopped') {
              // A stop claim requires positive evidence for EVERY path: each
              // one disarmed, and each one's executor demonstrably not beating.
              for (const path of result.paths) {
                assert.equal(path.armed, false, `${path.id} not disarmed but stopped — ${label}`);
                assert.equal(path.effective.state, 'stopped', `${path.id} not proven stopped — ${label}`);
              }
              assert.ok(
                ['down'].includes(watcher) && ['down'].includes(autoMerge),
                `stopped claimed with a live executor — ${label}`,
              );
            }

            // An armed path always makes the aggregate say merges are possible.
            if (result.paths.some((path) => path.armed === true)) {
              assert.equal(result.stopState.state, 'merging-possible', `armed path not surfaced — ${label}`);
            }
          }
        }
      }
    }
  });
});

describe('load independence', () => {
  it('derives from the governing inputs alone — no store, no filesystem', async () => {
    // Requirement 3: the derivation must be O(1) and load-independent. The
    // strongest form of that guarantee is structural — the module cannot read
    // anything whose size depends on the pipeline's load, because it imports
    // nothing that could.
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const source = readFileSync(
      fileURLToPath(new URL('../src/governance/merge-paths.mjs', import.meta.url)),
      'utf8',
    );
    const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]);
    assert.deepEqual(imports, ['./keys.mjs'], 'merge-paths must import only the key registry');
  });

  it('gives the same answer regardless of how much review state exists', () => {
    const resolved = keys({ enabled: true, autonomousMergeExecutionEnabled: false });
    const probes = daemons();
    const first = deriveMergePaths({ keys: resolved, daemons: probes });
    // Same inputs, called again after a store of any size would have grown:
    // there is no input to this function that carries per-PR state at all.
    const second = deriveMergePaths({ keys: resolved, daemons: probes });
    assert.deepEqual(second, first);
  });
});
