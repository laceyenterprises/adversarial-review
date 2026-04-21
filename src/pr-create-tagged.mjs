#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { buildTaggedTitle } from './pr-title-tagging.mjs';

const execFileAsync = promisify(execFile);

const HELP_TEXT = `Usage:
  node src/pr-create-tagged.mjs --tag <tag> --title "<title>" [--dry-run] [-- <gh pr create args...>]

Required:
  --tag      Tag source: codex | claude-code | clio-agent
  --title    Unprefixed PR title text

Optional:
  --dry-run  Print final title and command without creating the PR
  --         Everything after this is passed through to gh pr create

Examples:
  npm run pr:create:tagged -- --tag codex --title "LAC-180: add tagged PR helper" -- --body "Implements helper"
  npm run pr:create:tagged -- --tag claude-code --title "fix watcher race" -- --base main --draft
`;

function parseArgs(argv) {
  let tag;
  let title;
  let dryRun = false;
  const passthrough = [];
  let inPassthrough = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (inPassthrough) {
      passthrough.push(arg);
      continue;
    }

    if (arg === '--') {
      inPassthrough = true;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      return { help: true };
    }

    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }

    if (arg.startsWith('--tag=')) {
      tag = arg.slice('--tag='.length);
      if (!tag) {
        throw new Error('Missing value for --tag. Use --tag <tag> or --tag=<tag>.');
      }
      continue;
    }

    if (arg === '--tag') {
      const next = argv[i + 1];
      if (!next || next === '--' || next.startsWith('--')) {
        throw new Error('Missing value for --tag. Use --tag <tag> or --tag=<tag>.');
      }
      tag = next;
      i += 1;
      continue;
    }

    if (arg.startsWith('--title=')) {
      title = arg.slice('--title='.length);
      if (!title) {
        throw new Error('Missing value for --title. Use --title "<title>" or --title="<title>".');
      }
      continue;
    }

    if (arg === '--title') {
      const next = argv[i + 1];
      if (!next || next === '--' || next.startsWith('--')) {
        throw new Error('Missing value for --title. Use --title "<title>" or --title="<title>".');
      }
      title = next;
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}. Use "--" before raw gh args.`);
  }

  return { help: false, tag, title, dryRun, passthrough };
}

function validatePassthroughArgs(passthrough) {
  for (const arg of passthrough) {
    const shortFlags = arg.startsWith('-') && !arg.startsWith('--') ? (arg.slice(1).match(/[A-Za-z]/g) ?? []) : [];
    const includesShortTitleFlag = shortFlags.includes('t');
    if (
      arg === '--title' ||
      arg === '-t' ||
      arg.startsWith('--title=') ||
      includesShortTitleFlag
    ) {
      throw new Error('Do not pass --title to gh. Use --title on this helper so title tagging is enforced.');
    }
  }
}

function shellQuote(arg) {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(arg)) return arg;
  return `'${String(arg).replace(/'/g, `'\\''`)}'`;
}

function formatCommandForLog(command, args) {
  return [command, ...args].map(shellQuote).join(' ');
}

async function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    console.error(`[pr-create-tagged] ${err.message}`);
    console.error(HELP_TEXT);
    process.exit(1);
  }

  if (parsed.help) {
    console.log(HELP_TEXT);
    return;
  }

  const { tag, title, dryRun, passthrough } = parsed;

  let finalTitle;
  try {
    validatePassthroughArgs(passthrough);
    finalTitle = buildTaggedTitle(tag, title);
  } catch (err) {
    console.error(`[pr-create-tagged] ${err.message}`);
    console.error(HELP_TEXT);
    process.exit(1);
  }

  console.log(`[pr-create-tagged] Final PR title: ${finalTitle}`);

  const ghArgs = ['pr', 'create', '--title', finalTitle, ...passthrough];
  console.log(`[pr-create-tagged] Command (shell-escaped): ${formatCommandForLog('gh', ghArgs)}`);

  if (dryRun) {
    console.log('[pr-create-tagged] Dry run requested; exiting without creating PR.');
    return;
  }

  try {
    const { stdout, stderr } = await execFileAsync('gh', ghArgs, {
      env: process.env,
      maxBuffer: 1024 * 1024,
    });
    if (stdout?.trim()) console.log(stdout.trim());
    if (stderr?.trim()) console.error(stderr.trim());
  } catch (err) {
    const stderr = err?.stderr?.toString().trim();
    const stdout = err?.stdout?.toString().trim();
    if (stdout) console.error(stdout);
    if (stderr) console.error(stderr);
    console.error(`[pr-create-tagged] gh pr create failed: ${err.message}`);
    process.exit(1);
  }
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  return import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectExecution()) {
  main();
}

export {
  formatCommandForLog,
  main,
  parseArgs,
  validatePassthroughArgs,
};
