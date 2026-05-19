import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseSince, reviewerPassRows } from './reviewer-pass-tokens.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `\
Usage:
  adversarial-review tokens [--since 7d] [--by-pr | --by-reviewer] [--json] [--root-dir <path>]
`;

function parseArgs(argv) {
  const parsed = {
    since: null,
    byPr: false,
    byReviewer: false,
    json: false,
    rootDir: ROOT,
  };
  for (let idx = 0; idx < argv.length; idx += 1) {
    const arg = argv[idx];
    if (arg === '--since') {
      idx += 1;
      if (!argv[idx]) throw new Error('--since requires a value');
      parsed.since = argv[idx];
    } else if (arg === '--by-pr') {
      parsed.byPr = true;
    } else if (arg === '--by-reviewer') {
      parsed.byReviewer = true;
    } else if (arg === '--json') {
      parsed.json = true;
    } else if (arg === '--root-dir') {
      idx += 1;
      if (!argv[idx]) throw new Error('--root-dir requires a value');
      parsed.rootDir = argv[idx];
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  if (parsed.byPr && parsed.byReviewer) {
    throw new Error('--by-pr and --by-reviewer are mutually exclusive');
  }
  return parsed;
}

function rowTokens(row) {
  return Number(row.token_input || 0)
    + Number(row.token_output || 0)
    + Number(row.token_cache_read || 0)
    + Number(row.token_cache_write || 0);
}

function addBreakdown(target, row) {
  const key = row.reviewer_class || 'unknown';
  const bucket = target[key] || { passes: 0, tokens: 0, costUSD: null };
  bucket.passes += 1;
  bucket.tokens += rowTokens(row);
  if (row.token_cost_usd !== null && row.token_cost_usd !== undefined) {
    bucket.costUSD = (bucket.costUSD || 0) + Number(row.token_cost_usd || 0);
  }
  target[key] = bucket;
}

function summarizeRows(rows, mode = 'pass') {
  if (mode === 'pr') {
    const groups = new Map();
    for (const row of rows) {
      const key = `${row.repo}#${row.pr_number}`;
      const group = groups.get(key) || {
        repo: row.repo,
        prNumber: row.pr_number,
        roundCount: 0,
        totalTokens: 0,
        costUSD: null,
        reviewerClassBreakdown: {},
      };
      group.roundCount += 1;
      group.totalTokens += rowTokens(row);
      if (row.token_cost_usd !== null && row.token_cost_usd !== undefined) {
        group.costUSD = (group.costUSD || 0) + Number(row.token_cost_usd || 0);
      }
      addBreakdown(group.reviewerClassBreakdown, row);
      groups.set(key, group);
    }
    return [...groups.values()].sort((a, b) => b.totalTokens - a.totalTokens);
  }

  if (mode === 'reviewer') {
    const groups = new Map();
    for (const row of rows) {
      const key = row.reviewer_class || 'unknown';
      const group = groups.get(key) || {
        reviewerClass: key,
        passCount: 0,
        totalTokens: 0,
        costUSD: null,
      };
      group.passCount += 1;
      group.totalTokens += rowTokens(row);
      if (row.token_cost_usd !== null && row.token_cost_usd !== undefined) {
        group.costUSD = (group.costUSD || 0) + Number(row.token_cost_usd || 0);
      }
      groups.set(key, group);
    }
    return [...groups.values()].sort((a, b) => b.totalTokens - a.totalTokens);
  }

  return rows.map((row) => ({
    repo: row.repo,
    prNumber: row.pr_number,
    attemptNumber: row.attempt_number,
    passKind: row.pass_kind,
    reviewerClass: row.reviewer_class,
    status: row.status,
    totalTokens: rowTokens(row),
    inputTokens: row.token_input,
    outputTokens: row.token_output,
    cacheReadTokens: row.token_cache_read,
    cacheWriteTokens: row.token_cache_write,
    costUSD: row.token_cost_usd,
    tokenSource: row.token_source,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  }));
}

function formatCost(value) {
  return value === null || value === undefined ? '-' : `$${Number(value).toFixed(2)}`;
}

function formatTokens(value) {
  return String(Number(value || 0));
}

function formatBreakdown(value) {
  return Object.entries(value || {})
    .map(([klass, item]) => `${klass}:${formatTokens(item.tokens)}${item.costUSD === null ? '' : `/${formatCost(item.costUSD)}`}`)
    .join(', ') || '-';
}

function table(lines) {
  const widths = [];
  for (const line of lines) {
    line.forEach((cell, idx) => {
      widths[idx] = Math.max(widths[idx] || 0, String(cell).length);
    });
  }
  return `${lines.map((line) => line.map((cell, idx) => String(cell).padEnd(widths[idx])).join('  ')).join('\n')}\n`;
}

function render(summary, mode) {
  if (mode === 'pr') {
    return table([
      ['PR', 'rounds', 'tokens', 'cost', 'reviewers'],
      ...summary.map((row) => [
        `${row.repo}#${row.prNumber}`,
        row.roundCount,
        formatTokens(row.totalTokens),
        formatCost(row.costUSD),
        formatBreakdown(row.reviewerClassBreakdown),
      ]),
    ]);
  }
  if (mode === 'reviewer') {
    return table([
      ['reviewer', 'passes', 'tokens', 'cost'],
      ...summary.map((row) => [
        row.reviewerClass,
        row.passCount,
        formatTokens(row.totalTokens),
        formatCost(row.costUSD),
      ]),
    ]);
  }
  return table([
    ['PR', 'attempt', 'kind', 'reviewer', 'status', 'tokens', 'cost', 'source'],
    ...summary.map((row) => [
      `${row.repo}#${row.prNumber}`,
      row.attemptNumber,
      row.passKind,
      row.reviewerClass,
      row.status,
      formatTokens(row.totalTokens),
      formatCost(row.costUSD),
      row.tokenSource || '-',
    ]),
  ]);
}

function main(argv, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  let args;
  try {
    args = parseArgs(argv);
    if (args.help) {
      stdout.write(USAGE);
      return 0;
    }
    const since = parseSince(args.since);
    const rows = reviewerPassRows(args.rootDir, { since });
    const mode = args.byPr ? 'pr' : (args.byReviewer ? 'reviewer' : 'pass');
    const summary = summarizeRows(rows, mode);
    if (args.json) {
      stdout.write(`${JSON.stringify({ since, mode, rows: summary }, null, 2)}\n`);
    } else {
      stdout.write(render(summary, mode));
    }
    return 0;
  } catch (err) {
    stderr.write(`error: ${err.message}\n\n${USAGE}`);
    return 2;
  }
}

export {
  main,
  parseArgs,
  render,
  summarizeRows,
};
