#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fetchHammerHeadRange } from '../src/ama/hammer-head-validation.mjs';
const [repo, reviewedHead, currentHead, baseRef] = process.argv.slice(2);
if (!repo || !reviewedHead || !currentHead || !baseRef) throw new Error('usage: hammer-head-context REPO REVIEWED HEAD BASE');
const exec = promisify(execFile);
const range = await fetchHammerHeadRange({ repo, reviewedHead, currentHead, baseRef,
  get: async path => JSON.parse((await exec('gh', ['api', path], { timeout: 15000 })).stdout) });
if (!range) throw new Error('hammer head contains unverified or incomplete fleet ancestry');
process.stdout.write(`${JSON.stringify(range)}\n`);
