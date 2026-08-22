/**
 * ARF-08: a flip takes effect without a daemon bounce.
 *
 * This is the ticket's central claim, and it is the one thing that cannot be
 * proved by testing the gate in-process: the design it replaces fails precisely
 * *because* the process is long-lived. The watcher reads its governance config
 * at import time and caches its environment at boot, so an operator flipping
 * `autonomous_merge_execution_enabled` has changed nothing until a
 * `launchctl bootout` + `bootstrap` — and on 2026-07-26 two such halts, with
 * bounces, did not stop live merges.
 *
 * So these tests spawn genuinely long-lived merge-path processes — one Node,
 * one Python, matching the two runtimes the real merge paths run in — hold them
 * across every flip, and assert three things at once:
 *
 *   1. the **very next** decision reflects the flip, with no sleep, no poll,
 *      and no retry between the write returning and the question being asked;
 *   2. the pid is unchanged, so the new answer came from the same process and
 *      not from something that quietly restarted;
 *   3. both MSM merge paths are represented independently across the flip.
 *
 * The harnesses construct their `ArfGate` once at startup, exactly like the
 * daemons they stand in for. A harness that re-read config per question would
 * make this suite pass for the wrong reason.
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import { MASTER_SCOPE, MERGE_PATH_IDS } from '../../gate/gate-contract.mjs';
import { GateStore } from '../../server/src/governance/gate-store.mjs';

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');

const PYTHON_AVAILABLE = spawnSync('python3', ['--version']).error === undefined;

/**
 * A long-lived child that answers one decision per line.
 *
 * Deliberately not request/response over a fresh process: a fresh process would
 * re-read everything at startup and prove nothing about a daemon that does not.
 */
class MergePathProcess {
  constructor(command, args, env) {
    this.child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.buffer = '';
    this.pending = [];
    this.stderr = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => {
      this.buffer += chunk;
      let index = this.buffer.indexOf('\n');
      while (index !== -1) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        const resolveLine = this.pending.shift();
        if (resolveLine) resolveLine(JSON.parse(line));
        index = this.buffer.indexOf('\n');
      }
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => { this.stderr += chunk; });
  }

  /** Ask for a decision and wait for the answer. */
  ask(pathId) {
    return new Promise((resolveAnswer, rejectAnswer) => {
      const timer = setTimeout(
        () => rejectAnswer(new Error(`merge-path harness did not answer "${pathId}": ${this.stderr}`)),
        10_000,
      );
      this.pending.push((value) => {
        clearTimeout(timer);
        resolveAnswer(value);
      });
      this.child.stdin.write(`${pathId}\n`);
    });
  }

  async close() {
    this.child.stdin.end('exit\n');
    await new Promise((resolveClose) => this.child.once('exit', resolveClose));
  }
}

describe('arm/disarm is honoured without a bounce', () => {
  let store;
  let node;
  let python;

  before(async () => {
    const root = mkdtempSync(join(tmpdir(), 'arf-nobounce-'));
    store = new GateStore({
      gatePath: join(root, 'governance', 'gate.json'),
      auditPath: join(root, 'governance', 'gate-audit.jsonl'),
    });
    store.init({ actor: 'paul', reason: 'install' });

    const env = { ARF_GATE_FILE: store.gatePath };
    node = new MergePathProcess(process.execPath, [join(FIXTURES, 'merge-path-harness.mjs')], env);
    if (PYTHON_AVAILABLE) {
      python = new MergePathProcess('python3', [join(FIXTURES, 'merge_path_harness.py')], env);
    }
  });

  after(async () => {
    await node?.close();
    await python?.close();
  });

  it('starts with both MSM merge paths armed in a running process', async () => {
    for (const id of MERGE_PATH_IDS) {
      assert.equal((await node.ask(id)).decision.allowed, true, `${id} should start armed`);
    }
  });

  it('sees a disarm on the very next decision, in the same process', async () => {
    const before = await node.ask('hammer');
    assert.equal(before.decision.allowed, true);

    // No signal, no restart, no config edit, no sleep. The write returns and the
    // next question is asked immediately.
    store.set({ scope: 'hammer', armed: false, actor: 'paul', reason: 'rebase storm' });

    const after = await node.ask('hammer');
    assert.equal(after.decision.allowed, false, 'the flip was not observed without a bounce');
    assert.equal(after.decision.code, 'disarmed-path');
    assert.equal(after.pid, before.pid, 'the answer must come from the same process');
  });

  it('leaves the other MSM path armed in that same process', async () => {
    // Both paths are represented, and they are genuinely independent: a gate
    // that disarmed the pair together would pass the test above and still be
    // the single collapsed switch this ticket exists to avoid.
    const answer = await node.ask('daemon-clean');
    assert.equal(answer.decision.allowed, true);
  });

  it('sees the re-arm on the very next decision too', async () => {
    const before = await node.ask('hammer');
    assert.equal(before.decision.allowed, false);

    store.set({ scope: 'hammer', armed: true, actor: 'paul', reason: 'settled' });

    const after = await node.ask('hammer');
    assert.equal(after.decision.allowed, true);
    assert.equal(after.pid, before.pid);
  });

  it('sees an emergency stop cover every path at once', async () => {
    const before = await node.ask('hammer');
    store.set({ scope: MASTER_SCOPE, armed: false, actor: 'paul', reason: 'emergency stop' });

    for (const id of MERGE_PATH_IDS) {
      const answer = await node.ask(id);
      assert.equal(answer.decision.allowed, false, `${id} should be stopped`);
      assert.equal(answer.decision.code, 'disarmed-master');
      assert.equal(answer.pid, before.pid);
    }

    store.set({ scope: MASTER_SCOPE, armed: true, actor: 'paul', reason: 'all clear' });
  });

  it('survives many flips without the process ever restarting', async () => {
    // A cache keyed on an mtime that a filesystem reports at one-second
    // resolution would serve a stale answer here: these flips land inside a
    // single timestamp tick and produce a same-sized document.
    const first = await node.ask('hammer');
    for (let i = 0; i < 25; i += 1) {
      const armed = i % 2 === 0;
      store.set({ scope: 'hammer', armed, actor: 'paul', reason: `flip ${i}` });
      const answer = await node.ask('hammer');
      assert.equal(answer.decision.allowed, armed, `flip ${i} was not observed`);
      assert.equal(answer.pid, first.pid);
    }
  });

  it('refuses in the running process the moment the gate is removed or corrupted', async () => {
    // Fail-closed has to hold for a daemon that is already up, not just at
    // boot: a gate that vanished mid-run must stop merges, not permit them.
    const before = await node.ask('hammer');
    assert.equal(before.decision.allowed, true);

    writeFileSync(store.gatePath, '{ truncated');

    const after = await node.ask('hammer');
    assert.equal(after.decision.allowed, false);
    assert.equal(after.decision.failClosed, true);
    assert.equal(after.pid, before.pid);

    // A corrupt gate is not something `init` overwrites — see the store — so
    // recovering means removing it deliberately, which is what an operator
    // would do too.
    unlinkSync(store.gatePath);
    store.init({ actor: 'paul', reason: 'reinstall' });
    assert.equal((await node.ask('hammer')).decision.allowed, true);
  });
});

describe('both runtimes honour the same flip', { skip: PYTHON_AVAILABLE ? false : 'python3 unavailable' }, () => {
  let store;
  let node;
  let python;

  before(async () => {
    const root = mkdtempSync(join(tmpdir(), 'arf-nobounce-py-'));
    store = new GateStore({
      gatePath: join(root, 'governance', 'gate.json'),
      auditPath: join(root, 'governance', 'gate-audit.jsonl'),
    });
    store.init({ actor: 'paul', reason: 'install' });
    const env = { ARF_GATE_FILE: store.gatePath };
    node = new MergePathProcess(process.execPath, [join(FIXTURES, 'merge-path-harness.mjs')], env);
    python = new MergePathProcess('python3', [join(FIXTURES, 'merge_path_harness.py')], env);
  });

  after(async () => {
    await node?.close();
    await python?.close();
  });

  it('stops the Node paths and the Python backstop with one write', async () => {
    // The watcher runs `hammer` and `daemon-clean` in Node; the auto-merge
    // backstop is a Python daemon. One flip has to reach all three, or an
    // operator reading "stopped" is reading about two of the three actors that
    // can merge.
    assert.equal((await node.ask('hammer')).decision.allowed, true);
    assert.equal((await python.ask('python-backstop')).decision.allowed, true);

    store.set({ scope: MASTER_SCOPE, armed: false, actor: 'paul', reason: 'emergency stop' });

    const nodeAnswer = await node.ask('hammer');
    const pythonAnswer = await python.ask('python-backstop');
    assert.equal(nodeAnswer.decision.allowed, false);
    assert.equal(pythonAnswer.decision.allowed, false);
    assert.equal(nodeAnswer.decision.code, pythonAnswer.decision.code);
  });

  it('re-arms both runtimes with one write, in the same processes', async () => {
    const nodeBefore = await node.ask('hammer');
    const pythonBefore = await python.ask('python-backstop');

    store.set({ scope: MASTER_SCOPE, armed: true, actor: 'paul', reason: 'all clear' });

    const nodeAfter = await node.ask('hammer');
    const pythonAfter = await python.ask('python-backstop');
    assert.equal(nodeAfter.decision.allowed, true);
    assert.equal(pythonAfter.decision.allowed, true);
    assert.equal(nodeAfter.pid, nodeBefore.pid);
    assert.equal(pythonAfter.pid, pythonBefore.pid);
  });

  it('gives both runtimes the same answer for every path on a mixed posture', async () => {
    store.set({ scope: 'hammer', armed: false, actor: 'paul', reason: 'hammer only' });

    for (const id of MERGE_PATH_IDS) {
      const fromNode = (await node.ask(id)).decision;
      const fromPython = (await python.ask(id)).decision;
      assert.equal(fromPython.allowed, fromNode.allowed, `${id} disagreed across runtimes`);
      assert.equal(fromPython.code, fromNode.code, `${id} code disagreed across runtimes`);
    }
  });
});
