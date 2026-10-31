#!/usr/bin/env node
import { reportHammerProgress } from '../src/ama/hammer-progress.mjs';

const [milestone, reason] = process.argv.slice(2);
if (!reportHammerProgress(milestone, { reason })) process.exitCode = 70;
