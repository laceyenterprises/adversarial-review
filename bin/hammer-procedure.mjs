#!/usr/bin/env node
import { reportHammerEarlyFailure } from '../src/ama/hammer-terminal-audit.mjs';
// Render versioned HAM procedures for manual callers; dispatch renders before launch.
import { isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { HAMMER_PHASES, renderHammerProcedure } from '../src/hammer-procedure.mjs';

const phase = process.argv[2];
if (!HAMMER_PHASES.includes(phase)
  || process.argv[3] !== '--render' || process.argv.length !== 4) {
  reportHammerEarlyFailure('invalid-procedure-request');
  process.stderr.write(`usage: hammer-procedure.mjs <${HAMMER_PHASES.join('|')}> --render\n`);
  process.exit(64);
}
try {
  if (process.env.HAM_ROOT_DIR) {
    const location = relative(realpathSync(process.env.HAM_ROOT_DIR), realpathSync(fileURLToPath(import.meta.url)));
    if (isAbsolute(location) || location === '..' || location.startsWith(`..${sep}`)) {
      throw new Error('refusing to render: hammer-procedure.mjs is outside dispatch HAM_ROOT_DIR');
    }
  }
  const values = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => key.startsWith('HAM_')).map(([key, value]) => [key.slice(4), value]));
  process.stdout.write(renderHammerProcedure(phase, values));
} catch (error) {
  reportHammerEarlyFailure('procedure-render-failed');
  process.stderr.write(`${error.message}\n`);
  process.exit(error.exitCode || 64);
}
