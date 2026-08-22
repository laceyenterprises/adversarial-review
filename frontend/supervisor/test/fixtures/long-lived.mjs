#!/usr/bin/env node
/**
 * A supervised child that stays up until it is told not to (ARF-08 fixture).
 *
 * Appends its pid to `$PID_LOG` on every start, which is how the restart tests
 * tell "the same process is still there" from "a new one was started" — a
 * status field alone could be written by a supervisor that only *thought* it
 * had restarted something.
 */

import { appendFileSync } from 'node:fs';

appendFileSync(process.env.PID_LOG, `${process.pid}\n`);

// A referenced timer, so the process stays alive with nothing else to do.
const keepAlive = setInterval(() => {}, 60_000);

process.on('SIGTERM', () => {
  clearInterval(keepAlive);
  process.exit(0);
});
