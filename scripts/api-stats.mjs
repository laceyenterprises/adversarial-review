#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATEGORY_ORDER, resolveApiCallLogDir } from '../src/api-telemetry.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BUDGET = 5000;
const DEFAULT_SINCE = '1h';
const SINCE_PATTERN = /^(\d+)([hd])$/;

function parseArgs(argv = process.argv.slice(2)) {
  const args = { since: DEFAULT_SINCE, budget: DEFAULT_BUDGET, repo: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--since') {
      args.since = argv[++index];
    } else if (arg === '--budget') {
      args.budget = Number.parseInt(argv[++index], 10);
    } else if (arg === '--repo') {
      args.repo = argv[++index];
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function usage() {
  return [
    'Usage: node scripts/api-stats.mjs [--since 1h|24h|7d] [--budget N] [--repo owner/name]',
    '',
    'Defaults:',
    '  --since 1h',
    '  --budget 5000',
  ].join('\n');
}

function parseSinceWindow(input) {
  const raw = String(input || '').trim();
  const match = SINCE_PATTERN.exec(raw);
  if (!match) {
    throw new Error(`Invalid --since value: ${input}`);
  }
  const amount = Number.parseInt(match[1], 10);
  const unit = match[2];
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`Invalid --since value: ${input}`);
  }
  return {
    raw,
    amount,
    unit,
    durationMs: amount * (unit === 'h' ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000),
  };
}

function listLogFiles(rootDir = ROOT) {
  const logDir = resolveApiCallLogDir(rootDir);
  if (!existsSync(logDir)) return [];
  return readdirSync(logDir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
    .sort()
    .map((name) => join(logDir, name));
}

function readApiCallRows(rootDir = ROOT) {
  const rows = [];
  for (const filePath of listLogFiles(rootDir)) {
    const content = readFileSync(filePath, 'utf8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      rows.push(JSON.parse(line));
    }
  }
  return rows;
}

function filterRows(rows, {
  since = parseSinceWindow(DEFAULT_SINCE),
  repo = null,
  nowMs = Date.now(),
} = {}) {
  const cutoffMs = nowMs - since.durationMs;
  return rows.filter((row) => {
    const timestampMs = Date.parse(row?.timestamp || '');
    if (!Number.isFinite(timestampMs) || timestampMs < cutoffMs) return false;
    if (repo && row?.repo !== repo) return false;
    return true;
  });
}

function summarizeApiCallRows(rows, { budget = DEFAULT_BUDGET } = {}) {
  const callsByCategory = new Map();
  const callsByRepo = new Map();
  let totalCalls = 0;
  let throttleActivations = 0;
  let throttleSeconds = 0;

  for (const row of rows) {
    if (row?.category === 'rate_limit_throttle_seconds') {
      throttleActivations += 1;
      throttleSeconds += Number.isFinite(Number(row?.durationMs)) ? Number(row.durationMs) / 1000 : 0;
      continue;
    }
    totalCalls += 1;
    callsByCategory.set(row.category, (callsByCategory.get(row.category) || 0) + 1);
    if (row?.repo) {
      callsByRepo.set(row.repo, (callsByRepo.get(row.repo) || 0) + 1);
    }
  }

  return {
    budget,
    totalCalls,
    budgetRemaining: budget - totalCalls,
    percentUsed: budget > 0 ? (totalCalls / budget) * 100 : 0,
    throttleActivations,
    throttleSeconds,
    categoryRows: CATEGORY_ORDER
      .filter((category) => category !== 'rate_limit_throttle_seconds')
      .map((category) => ({ category, count: callsByCategory.get(category) || 0 }))
      .filter((row) => row.count > 0),
    repoRows: [...callsByRepo.entries()]
      .map(([repo, count]) => ({ repo, count }))
      .sort((left, right) => right.count - left.count || left.repo.localeCompare(right.repo)),
  };
}

function formatApiStats(summary, { since } = {}) {
  const lines = [];
  lines.push(`Window: ${since.raw}`);
  lines.push(
    `Total calls: ${summary.totalCalls}/${summary.budget} (${summary.percentUsed.toFixed(1)}%)`
    + ` | Remaining: ${summary.budgetRemaining}`
  );
  lines.push(`Throttle activations: ${summary.throttleActivations} (${summary.throttleSeconds.toFixed(0)}s total)`);
  if (summary.categoryRows.length > 0) {
    lines.push('By category:');
    for (const row of summary.categoryRows) {
      lines.push(`  ${row.category}: ${row.count}`);
    }
  }
  if (summary.repoRows.length > 0) {
    lines.push('By repo:');
    for (const row of summary.repoRows) {
      lines.push(`  ${row.repo}: ${row.count}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

async function main(argv = process.argv.slice(2), {
  rootDir = ROOT,
  nowMs = Date.now(),
} = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const since = parseSinceWindow(args.since);
  if (!Number.isFinite(args.budget) || args.budget <= 0) {
    throw new Error(`Invalid --budget value: ${args.budget}`);
  }
  const rows = readApiCallRows(rootDir);
  const filteredRows = filterRows(rows, {
    since,
    repo: args.repo,
    nowMs,
  });
  const summary = summarizeApiCallRows(filteredRows, { budget: args.budget });
  process.stdout.write(formatApiStats(summary, { since }));
  return 0;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.stderr.write(`${usage()}\n`);
    process.exit(1);
  });
}

export {
  DEFAULT_BUDGET,
  DEFAULT_SINCE,
  filterRows,
  formatApiStats,
  listLogFiles,
  main,
  parseArgs,
  parseSinceWindow,
  readApiCallRows,
  summarizeApiCallRows,
  usage,
};
