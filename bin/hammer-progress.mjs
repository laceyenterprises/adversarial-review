#!/usr/bin/env node
import { recordHammerPhase } from '../src/ama/hammer-outcome.mjs';
import { HAMMER_PROGRESS_MILESTONES, reportHammerProgress, reportRemediationCommit } from '../src/ama/hammer-progress.mjs';

// terminal-stop is accepted only with --final, on the run's last exit. --final
// may appear in any position; the remaining arguments are <milestone> [reason].
const args = process.argv.slice(2);
const final = args.includes('--final');
const [milestone, reason] = args.filter(arg => arg !== '--final');
if (milestone === '--phase') {
  recordHammerPhase(reason);
} else if (!HAMMER_PROGRESS_MILESTONES.includes(milestone)
  || (milestone === 'terminal-stop' && (!final || !reason))) {
  process.stderr.write('usage: hammer-progress <milestone> | hammer-progress terminal-stop --final <reason-code>\n');
  process.exitCode = 64;
} else if (milestone === 'remediation-committed') {
  if (!reportRemediationCommit()) process.exitCode = 70;
} else if (milestone.startsWith('validation-')) {
  // Validation receipts belong exclusively to the bounded validation helper.
  process.stderr.write('Validation milestones require hammer-validate.mjs; run the validation command through that helper.\n');
  process.exitCode = 64;
} else if (!reportHammerProgress(milestone, { reason, final, headSha: milestone === 'remediation-pushed' ? reason : undefined })) process.exitCode = 70;
