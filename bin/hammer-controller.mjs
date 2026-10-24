#!/usr/bin/env node
import { assertHammerController, runHammerController } from '../src/ama/hammer-controller.mjs';

try {
  const [verb, ...args] = process.argv.slice(2);
  if (verb === 'assert-owner' && args.length === 0) assertHammerController(process.env);
  else if (verb === 'run' && args.length) process.exitCode = await runHammerController(args.shift(), args);
  else {
    console.error('usage: hammer-controller.mjs run <closure-script> [args...] | assert-owner');
    process.exitCode = 64;
  }
} catch (error) {
  console.error(`hammer-controller: ${error.message}`);
  process.exitCode = 125;
}
