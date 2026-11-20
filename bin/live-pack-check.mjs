#!/usr/bin/env node
// Production merge preflight, sharing the reviewer's fail-closed live-pack rule.
import { prepareDispatchReadContext } from '../src/dispatch-read-client.mjs';
import { checkLivePackMerge } from '../src/live-pack-merge-check.mjs';

const [repo, prNumber, headSha] = process.argv.slice(2);
const ready = await prepareDispatchReadContext();
const result = ready.ok ? await checkLivePackMerge({ repo, prNumber, headSha }) : ready;
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exitCode = result.ok ? 0 : 1;
