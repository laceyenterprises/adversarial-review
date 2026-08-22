/**
 * ARF-08: the arm/disarm gate.
 *
 * Four properties, and every case here is one of them:
 *
 *  1. **Both merge paths are represented, independently.** Disarming `hammer`
 *     must not disarm `daemon-clean` and must not leave it looking disarmed.
 *     The failure this prevents is a panel that collapses the MSM two-path
 *     model into one switch and misreports the stop-state.
 *  2. **The read is O(1) and load-independent.** A fixed number of filesystem
 *     operations per decision, whatever is in the review store and whatever
 *     has been written to the audit trail.
 *  3. **Every unclear answer is a refusal.** Missing, unreadable, oversized,
 *     malformed, wrong-version, path-absent — all refuse, all flagged
 *     `failClosed` so a caller can tell a broken gate from a deliberate stop.
 *  4. **A flip cannot be lost.** Concurrent writers serialize, and a caller
 *     holding a stale read cannot clobber a change it never saw.
 */

import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ArfGate, readGateBytes } from '../../gate/gate-client.mjs';
import {
  GATE_VERSION, MASTER_SCOPE, MAX_GATE_BYTES, MERGE_PATHS, MERGE_PATH_IDS, MSM_PATH_IDS, exitCodeFor,
} from '../../gate/gate-contract.mjs';
import { GateError } from '../src/governance/gate-document.mjs';
import { GateStore } from '../src/governance/gate-store.mjs';

function tmpGate() {
  const root = mkdtempSync(join(tmpdir(), 'arf-gate-'));
  return {
    root,
    gatePath: join(root, 'governance', 'gate.json'),
    auditPath: join(root, 'governance', 'gate-audit.jsonl'),
  };
}

function openStore(overrides = {}) {
  const paths = tmpGate();
  return { paths, store: new GateStore({ ...paths, ...overrides }) };
}

function armedStore() {
  const { paths, store } = openStore();
  store.init({ actor: 'paul', reason: 'install' });
  return { paths, store, gate: new ArfGate(paths.gatePath) };
}

describe('gate contract', () => {
  it('carries both MSM merge paths and the un-governed backstop', () => {
    // The ticket is "represent both merge paths"; the backstop is here because
    // neither existing kill-switch key stops it, so a gate that omitted it would
    // let an operator disarm everything it knows about and still see merges.
    assert.deepEqual(MSM_PATH_IDS, ['hammer', 'daemon-clean']);
    assert.deepEqual(MERGE_PATH_IDS, ['hammer', 'daemon-clean', 'python-backstop']);
    assert.equal(MERGE_PATHS.find((p) => p.id === 'python-backstop').msm, false);
  });

  it('maps a disarm and a fail-closed refusal to different exit codes', () => {
    // A wrapper has to be able to page on a broken gate without paging every
    // time an operator deliberately stops merges.
    assert.equal(exitCodeFor({ allowed: true, failClosed: false }), 0);
    assert.equal(exitCodeFor({ allowed: false, failClosed: false }), 3);
    assert.equal(exitCodeFor({ allowed: false, failClosed: true }), 4);
  });
});

describe('gate: both merge paths, independently', () => {
  it('disarms one MSM path without touching the other', () => {
    const { store, gate } = armedStore();

    store.set({ scope: 'hammer', armed: false, actor: 'paul', reason: 'hammer is looping' });

    const decisions = gate.decideAll();
    assert.equal(decisions.hammer.allowed, false);
    assert.equal(decisions.hammer.code, 'disarmed-path');
    assert.equal(decisions['daemon-clean'].allowed, true);
    assert.equal(decisions['python-backstop'].allowed, true);
  });

  it('disarms the other MSM path just as independently', () => {
    const { store, gate } = armedStore();

    store.set({ scope: 'daemon-clean', armed: false, actor: 'paul', reason: 'strict_mode question' });

    assert.equal(gate.decide('hammer').allowed, true);
    assert.equal(gate.decide('daemon-clean').allowed, false);
  });

  it('carries who disarmed a path and why, per path', () => {
    // The audit answers "what happened"; this answers "why is THIS path off",
    // which is the question asked while looking at the panel.
    const { store, gate } = armedStore();
    store.set({ scope: 'hammer', armed: false, actor: 'ada', reason: 'PR 5543 rebase storm' });

    const decision = gate.decide('hammer');
    assert.equal(decision.setBy, 'ada');
    assert.equal(decision.setReason, 'PR 5543 rebase storm');
    assert.ok(Date.parse(decision.setAt) > 0);
  });

  it('re-arms a path back to armed', () => {
    const { store, gate } = armedStore();
    store.set({ scope: 'hammer', armed: false, actor: 'paul', reason: 'stop' });
    store.set({ scope: 'hammer', armed: true, actor: 'paul', reason: 'fixed' });
    assert.equal(gate.decide('hammer').allowed, true);
  });

  it('the master scope stops every path at once', () => {
    const { store, gate } = armedStore();

    store.set({ scope: MASTER_SCOPE, armed: false, actor: 'paul', reason: 'emergency stop' });

    for (const id of MERGE_PATH_IDS) {
      assert.equal(gate.decide(id).allowed, false, `${id} should be stopped`);
      assert.equal(gate.decide(id).code, 'disarmed-master');
    }
  });

  it('an emergency stop covers a path the document does not enumerate', () => {
    // Forward-safety: a newer ARF adds a fourth path and an older document has
    // no entry for it. The master check runs before the per-path lookup, so the
    // stop still covers it rather than falling through to "no entry, allow".
    const { paths, store } = armedStore();
    store.set({ scope: MASTER_SCOPE, armed: false, actor: 'paul', reason: 'emergency stop' });

    const raw = JSON.parse(readFileSync(paths.gatePath, 'utf8'));
    delete raw.paths.hammer;
    writeFileSync(paths.gatePath, JSON.stringify(raw));

    const decision = new ArfGate(paths.gatePath).decide('hammer');
    assert.equal(decision.allowed, false);
    assert.equal(decision.code, 'disarmed-master');
  });

  it('restores the per-path posture when the emergency stop is lifted', () => {
    // Arming out of an emergency stop must not re-arm a path an operator had
    // deliberately disarmed before it — that would be a second, silent change
    // riding along with the one they asked for.
    const { store, gate } = armedStore();
    store.set({ scope: 'daemon-clean', armed: false, actor: 'paul', reason: 'known-bad' });
    store.set({ scope: MASTER_SCOPE, armed: false, actor: 'paul', reason: 'emergency stop' });
    store.set({ scope: MASTER_SCOPE, armed: true, actor: 'paul', reason: 'all clear' });

    assert.equal(gate.decide('hammer').allowed, true);
    assert.equal(gate.decide('daemon-clean').allowed, false, 'the pre-stop disarm must survive');
  });
});

describe('gate: the read is O(1) and load-independent', () => {
  it('performs exactly one document read per decision, whatever the document holds', () => {
    const { paths, store } = armedStore();

    let reads = 0;
    const counting = (path, maxBytes) => {
      reads += 1;
      return readGateBytes(path, maxBytes);
    };

    const gate = new ArfGate(paths.gatePath, { readBytes: counting });
    gate.decide('hammer');
    assert.equal(reads, 1);

    // Grow the audit trail and the number of recorded flips by two orders of
    // magnitude. If the decision cost tracked anything load-shaped, this is
    // where it would show.
    for (let i = 0; i < 200; i += 1) {
      store.set({ scope: 'hammer', armed: i % 2 === 0, actor: 'paul', reason: `flip ${i}` });
    }
    assert.ok(store.auditTail(500).length > 100, 'the audit really did grow');

    reads = 0;
    gate.decide('hammer');
    assert.equal(reads, 1, 'a decision is still one read after 200 flips');
  });

  it('answers every path from a single read', () => {
    // A caller looping decide() would read once per path and could straddle a
    // flip, so `hammer` and `daemon-clean` would answer from different documents.
    const { paths } = armedStore();
    let reads = 0;
    const gate = new ArfGate(paths.gatePath, {
      readBytes: (path, maxBytes) => {
        reads += 1;
        return readGateBytes(path, maxBytes);
      },
    });

    const decisions = gate.decideAll();
    assert.equal(reads, 1);
    assert.deepEqual(Object.keys(decisions), [...MERGE_PATH_IDS]);
  });

  it('keeps the document bounded no matter how many flips it has seen', () => {
    // The size bound is what makes "one read" also mean "constant work". A
    // document that accumulated history per flip would be O(flips) to parse.
    const { paths, store } = armedStore();
    for (let i = 0; i < 300; i += 1) {
      store.set({ scope: MERGE_PATH_IDS[i % 3], armed: i % 2 === 0, actor: 'paul', reason: `flip ${i}` });
    }
    const size = statSync(paths.gatePath).size;
    assert.ok(size < 2048, `gate document grew to ${size} bytes`);
    assert.equal(Object.keys(JSON.parse(readFileSync(paths.gatePath, 'utf8')).paths).length, 3);
  });

  it('refuses an oversized document instead of reading it', () => {
    // Neither constant-time nor safe. Refusing is the honest answer, and the
    // refusal is fail-closed: an oversized gate stops merges, it does not
    // permit them while somebody works out what wrote it.
    const { paths } = armedStore();
    writeFileSync(paths.gatePath, 'x'.repeat(MAX_GATE_BYTES + 1));

    const decision = new ArfGate(paths.gatePath).decide('hammer');
    assert.equal(decision.code, 'gate-oversize');
    assert.equal(decision.allowed, false);
    assert.equal(decision.failClosed, true);
  });

  it('reads no store, no network, and no audit on the decision path', () => {
    // The gate directory alone is enough to decide. Nothing else is consulted,
    // which is what makes the answer independent of the pipeline's state.
    const root = mkdtempSync(join(tmpdir(), 'arf-gate-only-'));
    mkdirSync(join(root, 'governance'));
    writeFileSync(join(root, 'governance', 'gate.json'), JSON.stringify({
      gateVersion: GATE_VERSION,
      seq: 1,
      updatedAt: new Date().toISOString(),
      master: { armed: true, actor: 'paul', reason: 'x', at: null },
      paths: Object.fromEntries(MERGE_PATH_IDS.map((id) => [id, { armed: true, actor: null, reason: null, at: null }])),
    }));

    assert.equal(new ArfGate(join(root, 'governance', 'gate.json')).decide('hammer').allowed, true);
    assert.deepEqual(readdirSync(join(root, 'governance')), ['gate.json'], 'the read created nothing');
  });
});

describe('gate: every unclear answer is a refusal', () => {
  const cases = [
    ['a missing document', (paths) => { /* never created */ }, 'gate-missing'],
    ['a document that is not JSON', (paths) => writeFileSync(paths.gatePath, '{ not json'), 'gate-malformed'],
    ['a document that is a JSON array', (paths) => writeFileSync(paths.gatePath, '[]'), 'gate-malformed'],
    ['a future gate version', (paths) => writeFileSync(paths.gatePath, JSON.stringify({
      gateVersion: GATE_VERSION + 1, seq: 1, updatedAt: 'x', master: { armed: true }, paths: {},
    })), 'gate-version-unsupported'],
    ['a master.armed that is a string', (paths) => writeFileSync(paths.gatePath, JSON.stringify({
      gateVersion: GATE_VERSION, seq: 1, updatedAt: 'x', master: { armed: 'true' }, paths: {},
    })), 'gate-malformed'],
    ['a document with no entry for the path', (paths) => writeFileSync(paths.gatePath, JSON.stringify({
      gateVersion: GATE_VERSION, seq: 1, updatedAt: 'x', master: { armed: true }, paths: {},
    })), 'path-absent'],
    ['an armed flag that is a string', (paths) => writeFileSync(paths.gatePath, JSON.stringify({
      gateVersion: GATE_VERSION, seq: 1, updatedAt: 'x', master: { armed: true }, paths: { hammer: { armed: 'true' } },
    })), 'path-absent'],
  ];

  for (const [what, prepare, code] of cases) {
    it(`refuses ${what} (${code})`, () => {
      const paths = tmpGate();
      mkdirSync(join(paths.root, 'governance'), { recursive: true });
      prepare(paths);

      const decision = new ArfGate(paths.gatePath).decide('hammer');
      assert.equal(decision.code, code);
      assert.equal(decision.allowed, false);
      assert.equal(decision.failClosed, true, 'a gate that could not be established is fail-closed');
    });
  }

  it('refuses bytes that are not valid UTF-8, even inside JSON that would parse', () => {
    // `Buffer#toString('utf8')` substitutes U+FFFD for a malformed sequence, so
    // an invalid byte buried in a `reason` used to leave a document that parsed
    // cleanly and read as armed here — while the Python backstop's strict decode
    // refused the same file. One merge path merging under a gate the other calls
    // broken is the multi-loader-parity failure this contract exists to prevent.
    const paths = tmpGate();
    mkdirSync(join(paths.root, 'governance'), { recursive: true });
    const json = JSON.stringify({
      gateVersion: GATE_VERSION,
      seq: 1,
      updatedAt: 'x',
      master: { armed: true, reason: 'RE' },
      paths: Object.fromEntries(MERGE_PATH_IDS.map((id) => [id, { armed: true }])),
    });
    const at = json.indexOf('RE') + 1;
    // 0xFF is not a legal byte anywhere in UTF-8, and it lands inside a string
    // value, so every structural character of the document is still intact.
    writeFileSync(paths.gatePath, Buffer.concat([
      Buffer.from(json.slice(0, at), 'utf8'), Buffer.from([0xff]), Buffer.from(json.slice(at), 'utf8'),
    ]));

    const raw = readGateBytes(paths.gatePath);
    assert.equal(raw.code, 'gate-malformed', 'the bytes are refused before they reach JSON.parse');
    assert.equal(raw.text, null);
    for (const decision of Object.values(new ArfGate(paths.gatePath).decideAll())) {
      assert.equal(decision.allowed, false);
      assert.equal(decision.code, 'gate-malformed');
      assert.equal(decision.failClosed, true);
    }
  });

  it('refuses a path id the contract does not define', () => {
    const { gate } = armedStore();
    const decision = gate.decide('hamer');
    assert.equal(decision.code, 'unknown-path');
    assert.equal(decision.allowed, false);
    // The message names the real ids: a typo'd path must not be a silent allow
    // and must not leave the caller guessing at the spelling.
    assert.match(decision.reason, /hammer/);
  });

  it('refuses to construct without a gate path', () => {
    // No ambient discovery and no default. A merge path that reached here
    // unconfigured has a bug, and inventing a path would make it a silent
    // "no gate, merge away".
    assert.throws(() => new ArfGate(undefined), TypeError);
    assert.throws(() => new ArfGate('  '), TypeError);
  });

  it('refuses a document ARF cannot open', { skip: process.getuid && process.getuid() === 0 }, () => {
    const { paths } = armedStore();
    chmodSync(paths.gatePath, 0o000);
    try {
      const decision = new ArfGate(paths.gatePath).decide('hammer');
      assert.equal(decision.code, 'gate-unreadable');
      assert.equal(decision.failClosed, true);
    } finally {
      chmodSync(paths.gatePath, 0o644);
    }
  });

  it('separates a deliberate disarm from a broken gate', () => {
    // Both stop the merge; only one needs an operator. Collapsing them would
    // either page on every planned stop or page on none of the broken ones.
    const { store, gate } = armedStore();
    store.set({ scope: 'hammer', armed: false, actor: 'paul', reason: 'stop' });
    assert.equal(gate.decide('hammer').failClosed, false);
  });
});

describe('gate: the writer is strict where the reader is tolerant', () => {
  it('refuses to rewrite a document with an unknown key', () => {
    // A hand-edited `armd: false` would read as an absent entry. Catching it at
    // write time is the only place it can still be pointed at.
    const { paths, store } = armedStore();
    const raw = JSON.parse(readFileSync(paths.gatePath, 'utf8'));
    raw.armd = false;
    writeFileSync(paths.gatePath, JSON.stringify(raw));

    assert.throws(
      () => store.set({ scope: 'hammer', armed: false, actor: 'paul', reason: 'x' }),
      (err) => err instanceof GateError && err.code === 'gate_malformed' && /armd/.test(err.message),
    );
  });

  it('refuses a document carrying a merge path it does not know', () => {
    const { paths, store } = armedStore();
    const raw = JSON.parse(readFileSync(paths.gatePath, 'utf8'));
    raw.paths['hammer-v2'] = { armed: true };
    writeFileSync(paths.gatePath, JSON.stringify(raw));

    assert.throws(
      () => store.set({ scope: 'hammer', armed: false, actor: 'paul', reason: 'x' }),
      (err) => err instanceof GateError && err.code === 'gate_malformed' && /hammer-v2/.test(err.message),
    );
    assert.match(store.describe().error.detail, /hammer-v2/);
  });

  it('tolerates an additive field the reader does not know', () => {
    // The other direction. A newer ARF adding a field must not stop every
    // pipeline that has not updated yet.
    const { paths } = armedStore();
    const raw = JSON.parse(readFileSync(paths.gatePath, 'utf8'));
    raw.paths.hammer.notInThisVersion = 'something later';
    writeFileSync(paths.gatePath, JSON.stringify(raw));

    assert.equal(new ArfGate(paths.gatePath).decide('hammer').allowed, true);
  });

  it('requires an actor and a reason on every change', () => {
    const { store } = armedStore();
    for (const change of [
      { scope: 'hammer', armed: false, reason: 'x' },
      { scope: 'hammer', armed: false, actor: 'paul' },
      { scope: 'hammer', armed: false, actor: '  ', reason: 'x' },
    ]) {
      assert.throws(
        () => store.set(change),
        (err) => err instanceof GateError && err.code === 'bad_request',
      );
    }
  });

  it('refuses a scope that is neither a path nor the master scope', () => {
    // The failure being prevented: `--path hamer` silently becoming an
    // emergency stop, or silently becoming a no-op.
    const { store } = armedStore();
    assert.throws(
      () => store.set({ scope: 'hamer', armed: false, actor: 'paul', reason: 'x' }),
      (err) => err instanceof GateError && err.code === 'bad_request',
    );
  });

  it('refuses to arm before the gate is installed', () => {
    const { store } = openStore();
    assert.throws(
      () => store.set({ scope: 'hammer', armed: true, actor: 'paul', reason: 'x' }),
      (err) => err instanceof GateError && err.code === 'gate_missing' && /arf gate init/.test(err.message),
    );
  });
});

describe('gate: writes are atomic and cannot be lost', () => {
  it('leaves no scratch file behind and stays world-readable', () => {
    // The pipeline daemons may run as another OS user; a 0600 gate would fail
    // closed for all of them the first time an operator installed it.
    const { paths, store } = armedStore();
    store.set({ scope: 'hammer', armed: false, actor: 'paul', reason: 'x' });

    const entries = readdirSync(join(paths.root, 'governance'));
    assert.deepEqual(entries.filter((name) => name.endsWith('.tmp')), []);
    assert.equal(statSync(paths.gatePath).mode & 0o777, 0o644);
  });

  it('increments seq on every write, including a repeated disarm', () => {
    // "Disarmed again at 04:12" is a real event — a second operator arriving and
    // confirming the stop — and collapsing it would lose that record.
    const { store } = armedStore();
    const first = store.set({ scope: 'hammer', armed: false, actor: 'paul', reason: 'stop' });
    const second = store.set({ scope: 'hammer', armed: false, actor: 'ada', reason: 'confirming' });
    assert.equal(second.document.seq, first.document.seq + 1);
    assert.equal(second.document.paths.hammer.actor, 'ada');
  });

  it('refuses a write from a caller holding a stale read', () => {
    // A panel open in a background tab must not be able to re-arm over a disarm
    // it never saw.
    const { store } = armedStore();
    const stale = store.read().seq;
    store.set({ scope: MASTER_SCOPE, armed: false, actor: 'ada', reason: 'emergency stop' });

    assert.throws(
      () => store.set({ scope: MASTER_SCOPE, armed: true, actor: 'paul', reason: 'looks fine to me', expectedSeq: stale }),
      (err) => err instanceof GateError && err.code === 'gate_conflict',
    );
    assert.equal(store.read().master.armed, false, 'the stop survived');
  });

  it('serializes two writers so neither flip is lost', () => {
    // Read-modify-write over a shared file: last-writer-wins would silently drop
    // one of these, and the one it dropped could be the disarm.
    const paths = tmpGate();
    const a = new GateStore(paths);
    const b = new GateStore(paths);
    a.init({ actor: 'paul', reason: 'install' });

    a.set({ scope: 'hammer', armed: false, actor: 'paul', reason: 'stop hammer' });
    b.set({ scope: 'daemon-clean', armed: false, actor: 'ada', reason: 'stop daemon-clean' });

    const document = a.read();
    assert.equal(document.paths.hammer.armed, false);
    assert.equal(document.paths['daemon-clean'].armed, false);
    assert.equal(document.seq, 3, 'both writes landed, in order');
  });

  it('breaks a lock whose holder is gone rather than jamming forever', () => {
    const { paths, store } = armedStore();
    // pid 2^22 is above every real pid on macOS and Linux, so it is reliably a
    // process that does not exist.
    writeFileSync(`${paths.gatePath}.lock`, JSON.stringify({ pid: 4194304, at: new Date().toISOString() }));

    store.set({ scope: 'hammer', armed: false, actor: 'paul', reason: 'x' });
    assert.equal(store.read().paths.hammer.armed, false);
  });
});

describe('gate: the lock is only ever broken for a holder that is gone', () => {
  /**
   * The contended-lock cases exercise "wait, then refuse". The real budget is
   * 100 x 20ms, and on a loaded host those 20ms sleeps stretch far enough that
   * the wait outlives the abandoned-lock window and the case stops testing what
   * it names. A short budget keeps the assertion about the *rule*, not the clock.
   */
  const FAST_LOCK = { lockAttempts: 3, lockPollMs: 1 };

  /** A lock file with whatever holder record the caller wants to simulate. */
  function plantLock(paths, holder) {
    mkdirSync(join(paths.root, 'governance'), { recursive: true });
    writeFileSync(`${paths.gatePath}.lock`, holder === null ? '' : JSON.stringify(holder));
  }

  it('waits out a live holder however old its lock is, rather than stealing it', () => {
    // The lost-update this lock exists to prevent. Age alone used to be enough
    // to break it, so a first writer that merely stalled in gate/audit I/O for
    // longer than the staleness window had its lock unlinked and its flip
    // silently overwritten by the second writer's rename.
    const { paths } = openStore();
    new GateStore({ ...paths }).init({ actor: 'paul', reason: 'install' });
    // This process is unambiguously alive, and the lock is stamped far enough in
    // the past that any age-based rule would call it abandoned.
    plantLock(paths, { pid: process.pid, owner: 'the-live-writer', at: new Date(Date.now() - 600_000).toISOString() });

    const second = new GateStore({ ...paths, now: () => Date.now() + 600_000, ...FAST_LOCK });
    assert.throws(
      () => second.set({ scope: 'hammer', armed: false, actor: 'ada', reason: 'concurrent disarm' }),
      (err) => err instanceof GateError && err.code === 'gate_locked',
      'an old-but-live lock must be a retryable refusal, never a steal',
    );
    // And the live holder's lock is still there for it to release itself.
    assert.equal(JSON.parse(readFileSync(`${paths.gatePath}.lock`, 'utf8')).owner, 'the-live-writer');
  });

  it('treats a fresh unreadable lock as held, not as abandoned', () => {
    // A writer between its `open` and its stamp write looks exactly like this.
    const { paths } = openStore();
    new GateStore({ ...paths }).init({ actor: 'paul', reason: 'install' });
    plantLock(paths, null);
    // The clock is pinned to the moment the lock was planted, so the lock stays
    // *fresh* for the whole retry budget however long the budget takes to run.
    const pinned = Date.now();
    const store = new GateStore({ ...paths, now: () => pinned, ...FAST_LOCK });

    assert.throws(
      () => store.set({ scope: 'hammer', armed: false, actor: 'paul', reason: 'x' }),
      (err) => err instanceof GateError && err.code === 'gate_locked',
    );
  });

  it('still clears an old unattributable lock, so crash debris cannot jam arm/disarm', () => {
    // The other half of the trade: refusing to break anything would let a lock
    // truncated by a crash disarm the arm/disarm surface permanently.
    const { paths } = openStore();
    new GateStore({ ...paths }).init({ actor: 'paul', reason: 'install' });
    plantLock(paths, null);

    const later = new GateStore({ ...paths, now: () => Date.now() + 600_000 });
    later.set({ scope: 'hammer', armed: false, actor: 'paul', reason: 'after a crash' });
    assert.equal(later.read().paths.hammer.armed, false);
  });

  it('releases only the lock it acquired', () => {
    // If our lock is broken and re-created by another writer while we work, an
    // unconditional unlink on the way out would remove *their* live lock and
    // hand a third writer one the second still believes it holds.
    const { paths } = openStore();
    new GateStore({ ...paths }).init({ actor: 'paul', reason: 'install' });

    let stamps = 0;
    const store = new GateStore({
      ...paths,
      now: () => {
        stamps += 1;
        // Stamp 1 is the lock record; by stamp 2 the lock is held and the write
        // is about to happen, which is the window this simulates.
        if (stamps === 2) {
          writeFileSync(`${paths.gatePath}.lock`, JSON.stringify({ pid: process.pid, owner: 'someone-else', at: new Date().toISOString() }));
        }
        return Date.now();
      },
    });
    store.set({ scope: 'hammer', armed: false, actor: 'paul', reason: 'x' });

    assert.equal(
      JSON.parse(readFileSync(`${paths.gatePath}.lock`, 'utf8')).owner,
      'someone-else',
      'the other writer\'s lock survived our release',
    );
  });
});

describe('gate: no flip goes into force unrecorded', () => {
  it('refuses to install when the audit trail cannot be written, and writes no gate', () => {
    // The gate write is durable and the audit append came after it, so an
    // ENOENT on the audit path left the gate live and unattributed — and because
    // init is idempotent, re-running it returned created:false and the missing
    // install record could never be recovered.
    const paths = tmpGate();
    const store = new GateStore({
      gatePath: paths.gatePath,
      auditPath: join(paths.root, 'audit-dir-is-a-file', 'gate-audit.jsonl'),
    });
    writeFileSync(join(paths.root, 'audit-dir-is-a-file'), 'not a directory');

    assert.throws(
      () => store.init({ actor: 'paul', reason: 'install' }),
      (err) => err instanceof GateError && err.code === 'gate_unwritable',
    );
    assert.equal(store.read(), null, 'the refusal changed nothing on disk');
    assert.equal(new ArfGate(paths.gatePath).decide('hammer').code, 'gate-missing');
  });

  it('refuses a flip when the audit trail cannot be written, and leaves the gate as it was', () => {
    const { paths, store } = armedStore();
    const broken = new GateStore({
      gatePath: paths.gatePath,
      auditPath: join(paths.root, 'audit-dir-is-a-file', 'gate-audit.jsonl'),
    });
    writeFileSync(join(paths.root, 'audit-dir-is-a-file'), 'not a directory');

    assert.throws(
      () => broken.set({ scope: 'hammer', armed: false, actor: 'paul', reason: 'emergency' }),
      (err) => err instanceof GateError && err.code === 'gate_unwritable',
    );
    // Unchanged seq, not just an unchanged flag: the document was never rewritten.
    assert.equal(store.read().seq, 1);
    assert.equal(store.read().paths.hammer.armed, true);
  });

  it('creates the audit directory when it is not the gate directory', () => {
    // The pre-flight is not only a check: an audit path deliberately pointed at
    // its own directory must still install, or the check would break a supported
    // configuration in the name of protecting it.
    const paths = tmpGate();
    const auditPath = join(paths.root, 'audit', 'gate-audit.jsonl');
    const store = new GateStore({ gatePath: paths.gatePath, auditPath });

    store.init({ actor: 'paul', reason: 'install' });
    store.set({ scope: 'hammer', armed: false, actor: 'ada', reason: 'stop' });

    const records = store.auditTail(10);
    assert.deepEqual(records.map((r) => r.event), ['init', 'disarm']);
    assert.equal(statSync(auditPath).isFile(), true);
  });
});

describe('gate: install and audit', () => {
  it('installs armed, so putting the gate in place does not stop a running pipeline', () => {
    const { store, gate } = armedStore();
    for (const id of MERGE_PATH_IDS) assert.equal(gate.decide(id).allowed, true);
    assert.equal(store.read().seq, 1);
  });

  it('installs disarmed on request', () => {
    const { paths, store } = openStore();
    store.init({ actor: 'paul', reason: 'staged rollout', armed: false });
    assert.equal(new ArfGate(paths.gatePath).decide('hammer').allowed, false);
  });

  it('is idempotent: re-running init never re-arms a disarmed path', () => {
    // An install script re-run must not quietly undo an operator's stop.
    const { store, gate } = armedStore();
    store.set({ scope: MASTER_SCOPE, armed: false, actor: 'paul', reason: 'emergency stop' });

    const again = store.init({ actor: 'installer', reason: 're-run' });
    assert.equal(again.created, false);
    assert.equal(gate.decide('hammer').allowed, false);
  });

  it('records who, what, and the resulting posture on every change', () => {
    const { store } = armedStore();
    store.set({ scope: 'hammer', armed: false, actor: 'ada', reason: 'PR 5543 rebase storm' });

    const [install, disarm] = store.auditTail(10);
    assert.equal(install.event, 'init');
    assert.equal(disarm.event, 'disarm');
    assert.equal(disarm.scope, 'hammer');
    assert.equal(disarm.actor, 'ada');
    // The posture after the change, so one line answers "what was in force"
    // without replaying every line before it.
    assert.deepEqual(disarm.effective, { hammer: false, 'daemon-clean': true, 'python-backstop': true });
  });

  it('reads a bounded tail, and drops a torn line rather than failing the read', () => {
    const { paths, store } = armedStore();
    for (let i = 0; i < 50; i += 1) {
      store.set({ scope: 'hammer', armed: i % 2 === 0, actor: 'paul', reason: `flip ${i}` });
    }
    appendFileSync(paths.auditPath, '{"at":"torn');
    appendFileSync(paths.auditPath, '\n');

    const tail = store.auditTail(5);
    assert.equal(tail.length, 5);
    // A single bad line must not hide every good line after it.
    assert.ok(tail.every((record) => typeof record.at === 'string'));
  });

  it('returns an empty audit rather than throwing when none exists', () => {
    const { store } = openStore();
    assert.deepEqual(store.auditTail(), []);
  });

  it('returns nothing when asked for no records', () => {
    // `slice(-0)` is `slice(0)`, so a naive implementation hands back the whole
    // trail to a caller that asked for none of it.
    const { store } = armedStore();
    assert.deepEqual(store.auditTail(0), []);
    assert.deepEqual(store.auditTail(-1), []);
  });
});

describe('gate: the panel is told what the pipeline is told', () => {
  it('derives describe() from the reader client, not a second derivation', () => {
    // A governance panel that disagrees with the thing it governs is worse than
    // no panel, so the panel's per-path answer comes from the same code the
    // merge path runs.
    const { store } = armedStore();
    store.set({ scope: 'daemon-clean', armed: false, actor: 'paul', reason: 'x' });

    const described = store.describe();
    assert.deepEqual(described.effective, { hammer: true, 'daemon-clean': false, 'python-backstop': true });
    for (const path of described.gate.paths) {
      assert.equal(path.effective, described.decisions[path.id].allowed, `${path.id} disagrees`);
    }
  });

  it('shows a path as not effective when the master scope is down, and says which', () => {
    const { store } = armedStore();
    store.set({ scope: MASTER_SCOPE, armed: false, actor: 'paul', reason: 'emergency stop' });

    const described = store.describe();
    const hammer = described.gate.paths.find((p) => p.id === 'hammer');
    // `armed` (this path's own switch) and `effective` (what happens) are kept
    // apart so the panel can explain the difference instead of contradicting
    // itself with two green rows and no merges.
    assert.equal(hammer.armed, true);
    assert.equal(hammer.effective, false);
    assert.match(hammer.effectiveReason, /emergency stop/);
  });

  it('reports a missing gate rather than failing the surface that explains it', () => {
    const { store } = openStore();
    const described = store.describe();
    assert.equal(described.installed, false);
    assert.equal(described.error, null);
    assert.deepEqual(described.effective, { hammer: false, 'daemon-clean': false, 'python-backstop': false });
    assert.equal(described.decisions.hammer.code, 'gate-missing');
  });

  it('reports a corrupt gate with the reason, and still refuses every path', () => {
    const { paths, store } = armedStore();
    writeFileSync(paths.gatePath, '{ truncated');

    const described = store.describe();
    assert.equal(described.installed, false);
    assert.equal(described.error.code, 'gate_malformed');
    assert.equal(described.decisions['daemon-clean'].allowed, false);
  });

  it('marks both MSM paths as such so a renderer cannot collapse them', () => {
    const { store } = armedStore();
    const msm = store.describe().gate.paths.filter((path) => path.msm).map((path) => path.id);
    assert.deepEqual(msm, ['hammer', 'daemon-clean']);
  });
});
