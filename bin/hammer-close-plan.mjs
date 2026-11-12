#!/usr/bin/env node
// HAMCONTROLLERSCRIPT-01: the close controller is shipped code. The closer
// supplies only data: this JSON plan. Validate it and print shell-quoted
// exports for the shipped controller; never accept shell from the plan.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLOSE_PLAN_FILE = 'close-plan.json';
const DOC_CURRENCY = new Set(['applicable', 'not applicable', 'skipped superproject-doc obligation']);
const KEYS = new Set(['auditDetailsFile', 'remediated', 'failingTestsFixed', 'docCurrency', 'validationFiles']);

const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const singleLine = value => typeof value === 'string' && value.trim() !== '' && !/[\r\n\0]/.test(value);
const count = value => Number.isSafeInteger(value) && value >= 0;

function inside(dir, path) {
  const location = relative(dir, path);
  return location !== '' && !isAbsolute(location) && location !== '..' && !location.startsWith(`..${sep}`);
}

export function parseClosePlan(text, { planPath, runDir }) {
  let plan;
  try { plan = JSON.parse(text); } catch { throw new Error('close plan is not valid JSON'); }
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new Error('close plan must be a JSON object');
  const unknown = Object.keys(plan).filter(key => !KEYS.has(key));
  if (unknown.length) throw new Error(`close plan has unknown keys: ${unknown.join(', ')}`);
  const realRun = realpathSync(runDir);
  if (realpathSync(dirname(planPath)) !== realRun) throw new Error('close plan must live in HAM_RUN_DIR');
  if (!singleLine(plan.auditDetailsFile)) throw new Error('auditDetailsFile must name the audit details file');
  const details = isAbsolute(plan.auditDetailsFile) ? plan.auditDetailsFile : `${realRun}/${plan.auditDetailsFile}`;
  let realDetails;
  try { realDetails = realpathSync(details); } catch { throw new Error('auditDetailsFile does not exist'); }
  if (!inside(realRun, realDetails) || !statSync(realDetails).isFile() || statSync(realDetails).size === 0) {
    throw new Error('auditDetailsFile must be a non-empty file in HAM_RUN_DIR');
  }
  const { total, blocking, nonBlocking } = plan.remediated || {};
  if (!count(total) || !count(blocking) || !count(nonBlocking) || total !== blocking + nonBlocking) {
    throw new Error('remediated must hold whole-number total, blocking and nonBlocking, with total = blocking + nonBlocking');
  }
  if (!singleLine(plan.failingTestsFixed)) throw new Error('failingTestsFixed must be one line (actual repairs or "suite already green")');
  const { status, reason } = plan.docCurrency || {};
  if (!DOC_CURRENCY.has(status)) throw new Error(`docCurrency.status must be one of: ${[...DOC_CURRENCY].join(', ')}`);
  if (!singleLine(reason)) throw new Error('docCurrency.reason must be one line naming covered files and docs');
  const files = plan.validationFiles ?? [];
  if (!Array.isArray(files) || files.some(file => !singleLine(file) || isAbsolute(file)
    || file.split('/').includes('..') || file.startsWith('-'))) {
    throw new Error('validationFiles must be repository-relative paths');
  }
  return {
    HAM_AUDIT_DETAILS_FILE: realDetails,
    HAM_AUDIT_REMEDIATED_TOTAL: String(total),
    HAM_AUDIT_REMEDIATED_BLOCKING: String(blocking),
    HAM_AUDIT_REMEDIATED_NON_BLOCKING: String(nonBlocking),
    HAM_FAILING_TESTS_FIXED: plan.failingTestsFixed,
    HAM_DOC_CURRENCY: status,
    HAM_DOC_CURRENCY_REASON: reason,
    validationFiles: files,
  };
}

export function renderClosePlanExports(parsed) {
  const { validationFiles, ...exports } = parsed;
  return [
    ...Object.entries(exports).map(([key, value]) => `export ${key}=${shellQuote(value)}`),
    `HAM_CLOSE_VALIDATION_FILES=(${validationFiles.map(shellQuote).join(' ')})`,
  ].join('\n') + '\n';
}

function isMain() {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

if (isMain()) {
  const [verb, planPath, ...rest] = process.argv.slice(2);
  if (!['check', 'exports'].includes(verb) || !planPath || rest.length || !process.env.HAM_RUN_DIR) {
    process.stderr.write('usage: hammer-close-plan.mjs check|exports <HAM_RUN_DIR>/close-plan.json (HAM_RUN_DIR set)\n');
    process.exit(64);
  }
  try {
    const parsed = parseClosePlan(readFileSync(planPath, 'utf8'), { planPath, runDir: process.env.HAM_RUN_DIR });
    if (verb === 'exports') process.stdout.write(renderClosePlanExports(parsed));
  } catch (error) {
    // Data error: the closer corrects its plan data once and reruns the close.
    process.stderr.write(`close-plan-invalid: ${error.code === 'ENOENT' ? 'close plan file is missing' : error.message}\n`);
    process.exit(65);
  }
}
