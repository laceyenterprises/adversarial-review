#!/usr/bin/env node
/**
 * A supervised child that will not go quietly (ARF-08 fixture).
 *
 * Exercises the SIGKILL escalation. Without it a shutdown would hang forever,
 * an operator would reach for `kill -9` on the supervisor, and that would
 * orphan exactly the processes the supervisor exists to manage.
 */

import { appendFileSync } from 'node:fs';

appendFileSync(process.env.PID_LOG, `${process.pid}\n`);

const keepAlive = setInterval(() => {}, 60_000);

process.on('SIGTERM', () => {
  // Deliberately nothing. Installing the handler is what suppresses the default
  // terminate behaviour; an empty body is the whole point of the fixture.
  void keepAlive;
});
