#!/usr/bin/env node
import { HAMMER_PROGRESS_MILESTONES, reportHammerProgress } from '../src/ama/hammer-progress.mjs';

// terminal-stop is accepted only with --final, on the run's last exit. --final
// may appear in any position; the remaining arguments are <milestone> [reason].
const args = process.argv.slice(2);
const final = args.includes('--final');
const [milestone, reason] = args.filter(arg => arg !== '--final');
if (!HAMMER_PROGRESS_MILESTONES.includes(milestone)
  || (milestone === 'terminal-stop' && (!final || !reason))) {
  process.stderr.write('usage: hammer-progress <milestone> | hammer-progress terminal-stop --final <reason-code>\n');
  process.exitCode = 64;
} else if (!reportHammerProgress(milestone, { reason, final })) process.exitCode = 70;
