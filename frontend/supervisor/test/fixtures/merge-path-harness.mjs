#!/usr/bin/env node
/**
 * A stand-in for a long-lived Node merge path (ARF-08 test fixture).
 *
 * The watcher runs the `hammer` and `daemon-clean` paths, boots once, and stays
 * up for days. That longevity is the whole reason the config-flag design needs a
 * bounce: the daemon read its governance config at import time and nothing
 * re-reads it.
 *
 * So this harness deliberately does what a real daemon does — constructs its
 * gate **once at startup** and holds it for the life of the process — and then
 * answers a decision per line on stdin. A test can flip the gate from outside
 * and watch the answer change in a process it never restarted, with the pid in
 * every response to prove it.
 */

import { createInterface } from 'node:readline';

import { ArfGate } from '../../../gate/gate-client.mjs';

// Constructed once, at boot, exactly like the daemon this stands in for.
const gate = new ArfGate(process.env.ARF_GATE_FILE);

const lines = createInterface({ input: process.stdin });

lines.on('line', (line) => {
  const pathId = line.trim();
  if (pathId === '') return;
  if (pathId === 'exit') {
    lines.close();
    return;
  }
  const decision = pathId === 'all' ? gate.decideAll() : gate.decide(pathId);
  process.stdout.write(`${JSON.stringify({ pid: process.pid, runtime: 'node', decision })}\n`);
});

lines.on('close', () => process.exit(0));
