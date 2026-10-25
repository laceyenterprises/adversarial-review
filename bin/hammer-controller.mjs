#!/usr/bin/env node
import { assertHammerController, confirmControllerLaunch, runHammerController } from '../src/ama/hammer-controller.mjs';

try {
  const [verb, ...args] = process.argv.slice(2);
  if (verb === 'assert-owner' && args.length === 0) assertHammerController(process.env);
  else if (verb === 'assert-launch' && args.length === 0) {
    assertHammerController(process.env);
    if (!await confirmControllerLaunch()) throw new Error('HQ launch has no fresh permitted read; refusing this step');
  }
  else if (verb === 'run' && args.length) process.exitCode = await runHammerController(args.shift(), args);
  else {
    console.error('usage: hammer-controller.mjs run <closure-script> [args...] | assert-owner | assert-launch');
    process.exitCode = 64;
  }
} catch (error) {
  console.error(`hammer-controller: ${error.message}`);
  process.exitCode = 125;
}
