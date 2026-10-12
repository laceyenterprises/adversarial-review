#!/usr/bin/env node
import { exactHammerValidation } from '../src/ama/hammer-head-validation.mjs';

const [base, head, marker] = process.argv.slice(2);
let input = '';
for await (const chunk of process.stdin) input += chunk;
// gh api --paginate --slurp emits an outer array containing each page.
const comments = JSON.parse(input).flat();
const match = comments.find(comment => Number.isSafeInteger(comment.id)
  && exactHammerValidation(comment, head)
  && String(comment.body || '').includes(marker)
  && String(comment.body || '').split(/\r?\n/).some(value => value.trim() === `HAM-Base-Head: ${base}`));
if (match) process.stdout.write(`${match.id}\n`);
