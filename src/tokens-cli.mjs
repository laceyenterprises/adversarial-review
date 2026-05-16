import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openReviewStateDb } from './review-state.mjs';
import {
  formatReviewerPassRollup,
  queryReviewerPassRollup,
} from './reviewer-passes.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(__dirname, '..');

const USAGE = `\
Usage:
  adversarial-review tokens [--since 7d] [--by-pr | --by-reviewer] [--json] [--root <path>]
`;

function parseTokensArgs(argv) {
  const opts = {
    since: null,
    byPr: false,
    byReviewer: false,
    json: false,
    rootDir: DEFAULT_ROOT,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--since') {
      opts.since = argv[++i];
    } else if (arg === '--by-pr') {
      opts.byPr = true;
    } else if (arg === '--by-reviewer') {
      opts.byReviewer = true;
    } else if (arg === '--json') {
      opts.json = true;
    } else if (arg === '--root') {
      opts.rootDir = argv[++i];
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  if (opts.byPr && opts.byReviewer) {
    throw new Error('--by-pr and --by-reviewer are mutually exclusive');
  }
  return opts;
}

function main(argv, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  let opts;
  try {
    opts = parseTokensArgs(argv);
  } catch (err) {
    stderr.write(`error: ${err.message}\n\n${USAGE}`);
    return 2;
  }
  if (opts.help) {
    stdout.write(USAGE);
    return 0;
  }

  const db = openReviewStateDb(opts.rootDir);
  try {
    const rows = queryReviewerPassRollup(db, opts);
    if (opts.json) {
      stdout.write(`${JSON.stringify({ rows }, null, 2)}\n`);
    } else {
      stdout.write(formatReviewerPassRollup(rows, opts));
    }
    return 0;
  } finally {
    db.close();
  }
}

export {
  USAGE,
  main,
  parseTokensArgs,
};
