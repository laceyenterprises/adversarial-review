#!/usr/bin/env node
// Production merge preflight, sharing the reviewer's fail-closed live-pack rule.
import { checkLivePackMerge } from '../src/live-pack-merge-check.mjs';

const [repo, prNumber, headSha] = process.argv.slice(2);
const result = await checkLivePackMerge({ repo, prNumber, headSha });
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exitCode = result.ok ? 0 : 1;
