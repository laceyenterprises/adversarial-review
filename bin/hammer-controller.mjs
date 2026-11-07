#!/usr/bin/env node
import { assertHammerController, confirmControllerLaunch, reportLaunchEnvironmentFailure, resolveLaunchEnvironment,
  runHammerController } from '../src/ama/hammer-controller.mjs';
import { HAMMER_RETRYABLE_READ_OUTCOMES } from '../src/ama/hammer-phase-outcome.mjs';

try {
  const [verb, ...args] = process.argv.slice(2);
  if (verb === 'assert-owner' && args.length === 0) assertHammerController(process.env);
  else if (verb === 'assert-launch' && args.length === 0) {
    assertHammerController(process.env);
    if (!await confirmControllerLaunch()) throw new Error('HQ launch has no fresh permitted read; refusing this step');
  }
  else if (verb === 'resolve-environment' && args.length === 0) {
    // HAMMERLAUNCHREAD-01: before remediation, keep this launch's environment.
    // No secret or transport output is printed; only the kept activation.
    let resolved;
    try { resolved = resolveLaunchEnvironment(process.env); }
    catch (error) {
      reportLaunchEnvironmentFailure(error, process.env);
      if (HAMMER_RETRYABLE_READ_OUTCOMES.has(error.phaseOutcome)) {
        console.error('hammer-controller: exit 75 is an uncharged deferral, already audited; '
          + 'stop now, with no remediation, validation, no-merge comment or further audit');
      }
      throw error;
    }
    console.log(JSON.stringify({ launchEnvironment: 'resolved', source: resolved.source,
      dispatchReadsEnabled: resolved.env.ADVERSARIAL_DISPATCH_READS_ENABLED === '1' }));
  }
  else if (verb === 'run' && args.length) process.exitCode = await runHammerController(args.shift(), args);
  else {
    console.error('usage: hammer-controller.mjs resolve-environment | run <closure-script> [args...] | assert-owner | assert-launch');
    process.exitCode = 64;
  }
} catch (error) {
  console.error(`hammer-controller: ${error.message}`);
  process.exitCode = error.code === 'EOBSERVATION'
    || HAMMER_RETRYABLE_READ_OUTCOMES.has(error.phaseOutcome) ? 75 : 125;
}
