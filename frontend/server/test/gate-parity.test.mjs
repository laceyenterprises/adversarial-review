/**
 * ARF-08: the Node and Python gate clients must not drift.
 *
 * The gate is one document with two strict readers in two languages — the
 * watcher's merge paths are Node, the auto-merge backstop is Python. That is
 * exactly the `config-schema.multi-loader-parity` shape, and the recorded
 * failures of that class are not subtle: a key added to one loader and not the
 * others put the adversarial watcher into a respawn crash loop and stopped
 * reviews for over an hour (2026-07-17), and a canonical value changed in the
 * schema but not in its shell consumer broke the default 1Password install
 * outright (2026-07-20).
 *
 * The remedy those RCAs asked for is a schema-parity gate that *diffs* the
 * loaders. This is it. A constant changed in `gate-contract.mjs` and not in
 * `arf_gate.py` fails here, rather than at 3am as one merge path honouring a
 * disarm and the other not.
 *
 * Two levels, because the contract diff alone is not enough: identical
 * constants can still be *used* differently, so the decision matrix drives both
 * clients over the same documents and compares the answers.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { ArfGate } from '../../gate/gate-client.mjs';
import { GATE_VERSION, MERGE_PATH_IDS, contract } from '../../gate/gate-contract.mjs';

// test -> server -> arf
const ARF_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PY_CLIENT = join(ARF_ROOT, 'gate', 'arf_gate.py');

/**
 * Run the Python client, or report that Python is unavailable.
 *
 * A machine with no `python3` skips rather than fails: this suite's job is to
 * catch drift between two implementations, and it cannot make a claim about one
 * it could not run. The skip is loud in the test output rather than silent.
 */
function python(args) {
  const result = spawnSync('python3', [PY_CLIENT, ...args], { encoding: 'utf8' });
  if (result.error) return { unavailable: String(result.error.message) };
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const PROBE = python(['--contract']);
const SKIP = PROBE.unavailable ? `python3 unavailable: ${PROBE.unavailable}` : false;

/** A gate document, in the on-disk shape. */
function document({ master = true, paths = {}, version = GATE_VERSION, seq = 7 } = {}) {
  return {
    gateVersion: version,
    seq,
    updatedAt: '2026-08-19T12:00:00.000Z',
    master: { armed: master, actor: 'paul', reason: 'master reason', at: '2026-08-19T11:00:00.000Z' },
    paths: Object.fromEntries(MERGE_PATH_IDS.map((id) => [id, {
      armed: paths[id] === undefined ? true : paths[id],
      actor: `actor-${id}`,
      reason: `reason-${id}`,
      at: '2026-08-19T11:30:00.000Z',
    }])),
  };
}

function writeDocument(name, body) {
  const root = mkdtempSync(join(tmpdir(), 'arf-parity-'));
  const path = join(root, `${name}.json`);
  // A Buffer goes down verbatim: the byte-level cases below are exactly the ones
  // that cannot be expressed as a JS string.
  writeFileSync(path, Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body));
  return path;
}

/**
 * A structurally valid gate document with one byte that is not valid UTF-8,
 * inside a string value rather than anywhere the JSON grammar looks.
 *
 * The interesting case for parity, because the two runtimes disagreed about it
 * silently: CPython's `bytes.decode("utf-8")` raises, while Node's
 * `Buffer#toString('utf8')` substitutes U+FFFD and hands back a string that
 * parses — so the Node merge paths would read `armed: true` from a document the
 * Python backstop refused outright.
 */
function invalidUtf8Document() {
  const json = JSON.stringify(document());
  const at = json.indexOf('master reason') + 1;
  return Buffer.concat([
    Buffer.from(json.slice(0, at), 'utf8'),
    Buffer.from([0xff]),
    Buffer.from(json.slice(at), 'utf8'),
  ]);
}

/**
 * The fields a decision *means*, minus the free-text `reason`.
 *
 * `reason` is compared separately, and only for the codes whose text is fully
 * determined by the contract. The fail-closed codes splice in an OS or parser
 * message — `ENOENT: no such file` against `[Errno 2] No such file` — and
 * demanding those match would be asserting that Node and CPython word their
 * errors identically, which is not a property worth having.
 */
function semantics(decision) {
  return {
    path: decision.path,
    allowed: decision.allowed,
    code: decision.code,
    failClosed: decision.failClosed,
    setBy: decision.setBy,
    setAt: decision.setAt,
    setReason: decision.setReason,
    gate: decision.gate === null ? null : {
      version: decision.gate.version,
      seq: decision.gate.seq,
      updatedAt: decision.gate.updatedAt,
    },
  };
}

/** Codes whose `reason` is the contract summary verbatim, in both languages. */
const DETERMINISTIC_REASON_CODES = new Set(['armed', 'disarmed-path', 'disarmed-master']);

describe('gate parity: the contract itself', { skip: SKIP }, () => {
  it('is byte-identical between gate-contract.mjs and arf_gate.py', () => {
    const fromPython = JSON.parse(PROBE.stdout);
    // Deep-equal over the whole payload — versions, path ids, path metadata,
    // decision codes and their allowed/failClosed flags, and the exit codes.
    // Anything a reader's behaviour depends on is in here; anything left out is
    // something this gate cannot protect.
    assert.deepEqual(fromPython, JSON.parse(JSON.stringify(contract())));
  });

  it('agrees on which paths are the MSM two-path model', () => {
    const fromPython = JSON.parse(PROBE.stdout);
    assert.deepEqual(fromPython.msmPathIds, ['hammer', 'daemon-clean']);
    assert.deepEqual(fromPython.mergePathIds, [...MERGE_PATH_IDS]);
  });
});

describe('gate parity: the same documents produce the same decisions', { skip: SKIP }, () => {
  const CASES = [
    ['everything armed', document()],
    ['hammer disarmed', document({ paths: { hammer: false } })],
    ['daemon-clean disarmed', document({ paths: { 'daemon-clean': false } })],
    ['both MSM paths disarmed', document({ paths: { hammer: false, 'daemon-clean': false } })],
    ['emergency stop', document({ master: false })],
    ['emergency stop over a disarmed path', document({ master: false, paths: { hammer: false } })],
    ['backstop disarmed alone', document({ paths: { 'python-backstop': false } })],
    ['a future gate version', document({ version: GATE_VERSION + 1 })],
    ['a document with no paths', { gateVersion: GATE_VERSION, seq: 1, updatedAt: 'x', master: { armed: true }, paths: {} }],
    ['a non-boolean armed flag', {
      gateVersion: GATE_VERSION, seq: 1, updatedAt: 'x', master: { armed: true }, paths: { hammer: { armed: 'true' } },
    }],
    ['a master.armed that is a number', {
      gateVersion: GATE_VERSION, seq: 1, updatedAt: 'x', master: { armed: 1 }, paths: {},
    }],
    ['a truncated document', '{ "gateVersion": 1, "master"'],
    ['a JSON array', '[]'],
    ['a byte that is not valid UTF-8', invalidUtf8Document()],
    ['a UTF-8 BOM', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(document()), 'utf8')])],
  ];

  for (const [what, body] of CASES) {
    it(`agrees on ${what}`, () => {
      const path = writeDocument('gate', body);
      const nodeDecisions = new ArfGate(path).decideAll();
      const result = python(['--gate', path, '--json']);
      assert.equal(result.stderr, '', 'the python client wrote to stderr');
      const pythonDecisions = JSON.parse(result.stdout);

      for (const id of MERGE_PATH_IDS) {
        assert.deepEqual(
          semantics(pythonDecisions[id]),
          semantics(nodeDecisions[id]),
          `${what}: ${id} decided differently`,
        );
        if (DETERMINISTIC_REASON_CODES.has(nodeDecisions[id].code)) {
          assert.equal(pythonDecisions[id].reason, nodeDecisions[id].reason, `${what}: ${id} reason`);
        }
      }
    });
  }

  it('agrees that a missing document refuses every path', () => {
    const missing = join(mkdtempSync(join(tmpdir(), 'arf-parity-')), 'absent.json');
    const nodeDecisions = new ArfGate(missing).decideAll();
    const pythonDecisions = JSON.parse(python(['--gate', missing, '--json']).stdout);

    for (const id of MERGE_PATH_IDS) {
      assert.deepEqual(semantics(pythonDecisions[id]), semantics(nodeDecisions[id]));
      assert.equal(nodeDecisions[id].code, 'gate-missing');
      assert.equal(nodeDecisions[id].failClosed, true);
    }
  });

  it('agrees on an unknown path id', () => {
    const path = writeDocument('gate', document());
    const nodeDecision = new ArfGate(path).decide('hamer');
    const pythonDecision = JSON.parse(python(['--gate', path, '--path', 'hamer', '--json']).stdout);
    assert.deepEqual(semantics(pythonDecision), semantics(nodeDecision));
    assert.equal(nodeDecision.code, 'unknown-path');
  });
});

describe('gate parity: the process exit codes', { skip: SKIP }, () => {
  const CASES = [
    ['armed', document(), 'hammer', 0],
    ['disarmed by an operator', document({ paths: { hammer: false } }), 'hammer', 3],
    ['emergency stop', document({ master: false }), 'daemon-clean', 3],
    ['a malformed gate', '{ nope', 'hammer', 4],
    ['a byte that is not valid UTF-8', invalidUtf8Document(), 'hammer', 4],
    ['a future version', document({ version: 99 }), 'hammer', 4],
  ];

  for (const [what, body, pathId, expected] of CASES) {
    it(`exits ${expected} for ${what}`, () => {
      const path = writeDocument('gate', body);
      assert.equal(python(['--gate', path, '--path', pathId]).status, expected);
      assert.equal(new ArfGate(path).exitCodeFor(pathId), expected);
    });
  }

  it('reports the worst path when asked about all of them', () => {
    // A wrapper checking "is anything armed" must not read a zero as all clear
    // when one of the three paths is refusing.
    const path = writeDocument('gate', document({ paths: { 'daemon-clean': false } }));
    assert.equal(python(['--gate', path]).status, 3);
  });
});
