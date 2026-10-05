#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import { inspectCiBootstrap } from '../src/ci-recovery.mjs';
import { resolveGateStatusContext } from '../src/adversarial-gate-context.mjs';
import { resolveRequiredCheckContextsFromCfg } from '../src/ama/required-check-contexts.mjs';
import { loadConfigCached } from '../src/config-loader.mjs';

const { values } = parseArgs({ options: {
  repo: { type: 'string' }, pr: { type: 'string' }, head: { type: 'string' },
} });
if (!values.repo || !values.pr || !values.head) throw new Error('--repo, --pr and --head required');
const execFileAsync = promisify(execFile);
const { stdout } = await execFileAsync('gh', ['pr', 'view', values.pr, '--repo', values.repo,
  '--json', 'state,headRefOid,baseRefName,statusCheckRollup'], { timeout: 30_000 });
const pr = JSON.parse(stdout);
if (pr.state !== 'OPEN' || pr.headRefOid !== values.head) throw new Error('PR is terminal or head moved');
const result = await inspectCiBootstrap({ repo: values.repo, prNumber: Number(values.pr),
  headSha: values.head, baseBranch: pr.baseRefName, rollup: pr.statusCheckRollup,
  requiredContexts: resolveRequiredCheckContextsFromCfg(loadConfigCached()),
  ownContext: resolveGateStatusContext(), execFileImpl: execFileAsync });
if (result.mode !== 'no-ci-bootstrap') throw new Error('bootstrap CI evidence unavailable');
console.log(JSON.stringify(result));
