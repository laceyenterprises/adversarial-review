import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { killFixtureChild } from './helpers/fixture-child.mjs';

test('fixture cleanup rejects when a signalled child never closes', async () => {
  const child = new EventEmitter();
  child.pid = 2_147_483_647; // No process can hold this PID on supported hosts.
  child.exitCode = null;
  child.signalCode = null;
  await assert.rejects(
    killFixtureChild(child, { detached: false }),
    /did not close within 2 seconds/,
  );
});
