#!/usr/bin/env node
// Stdin bridge for shell writers; the transform remains the shared pure function.
import { readFileSync } from 'node:fs';
import { filterGitHubBody } from '../src/github-outbound-body.mjs';
const [repo, reviewerHeadSha, rootDir] = process.argv.slice(2);
let body = '';
try { body = readFileSync(0, 'utf8'); } catch { body = '<local>'; }
process.stdout.write(filterGitHubBody(body, { repo, reviewerHeadSha, rootDir }));
