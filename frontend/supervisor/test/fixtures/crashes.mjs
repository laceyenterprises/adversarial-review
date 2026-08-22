#!/usr/bin/env node
/**
 * A supervised child that dies immediately (ARF-08 fixture).
 *
 * Stands in for the real crash-loop causes — a bad command, a port already
 * bound, a config error thrown at import time — so the backoff and the
 * give-up-and-say-so cutoff can be exercised without waiting on one.
 */

import { appendFileSync } from 'node:fs';

appendFileSync(process.env.PID_LOG, `${process.pid}\n`);
process.exit(7);
