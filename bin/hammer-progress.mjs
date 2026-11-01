#!/usr/bin/env node
import { reportHammerProgress } from '../src/ama/hammer-progress.mjs';

// terminal-stop is accepted only with --final, on the run's last exit.
const args = process.argv.slice(2);
const final = args[1] === '--final';
const [milestone, reason] = final ? [args[0], args[2]] : args;
if (!reportHammerProgress(milestone, { reason, final })) process.exitCode = 70;
