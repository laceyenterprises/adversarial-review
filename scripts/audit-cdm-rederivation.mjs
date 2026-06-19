#!/usr/bin/env node
/**
 * Guard CDM-owned review-gate facts from being re-derived outside their owner.
 *
 * The canonical owner for verdict / reviewed head / mergeability gate facts is
 * `src/adversarial-gate-status.mjs`. This scanner intentionally stays cheap:
 * it looks for a local block that reads all three raw fact families and also
 * contains review-gate decision language. Single-field plumbing is allowed.
 *
 * Attached allowlist marker, on the finding line, inside the matched
 * fact/decision span, or immediately before the enclosing function/block:
 *   // cdm-allowlist: <reason>
 *
 * Allowlisted findings are still emitted in the JSON artifact so exceptions are
 * auditable. `--strict` exits non-zero only for non-allowlisted findings.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const OWNER_MODULE = 'src/adversarial-gate-status.mjs';
const SELF_MODULE = 'scripts/audit-cdm-rederivation.mjs';
const DEFAULT_SCAN_TARGETS = ['src', 'scripts', 'bin'];
const DEFAULT_INCLUDE_EXTENSIONS = new Set(['.mjs', '.js', '.cjs', '.ts', '.sh']);
const EXCLUDE_DIRS = new Set([
  '.git',
  'node_modules',
  'coverage',
  'dist',
  'build',
]);
const WINDOW_RADIUS = 35;

const ALLOWLIST_MARKER_RE = /(?:(?<!\S)(?:#|\/\/|\/\*|<!--|--)\s*cdm-allowlist:\s*(.+?)(?:\*\/|-->|$))/i;

const FACT_PATTERNS = Object.freeze({
  reviewerHead: [
    /\breviewer_head_sha\b/,
  ],
  reviewVerdict: [
    /\blast_verdict\b/,
    /\breview_body\b/,
    /\breviewBody\b/,
    /\bextractReviewVerdict\s*\(/,
  ],
  mergeability: [
    /\bnormalizeGithubMergeability\s*\(/,
    /\bmergeStateStatus\b/,
    /\bmergeable\b/,
  ],
});

const DECISION_PATTERNS = [
  /\bisEligibleForAmaClosure\s*\(/i,
  /\bmaybeDispatchAmaCloser\s*\(/i,
  /\bSETTLED_SUCCESS_VERDICTS\b/i,
  /\bpr-not-mergeable\b/i,
  /\bstale-review-head\b/i,
  /\bMERGEABLE\b/i,
  /\bCONFLICTING\b/i,
  /\bapproved\b/i,
  /\bcomment-only\b/i,
  /\brequest-changes\b/i,
  /\bheadSha\b/,
  /\bmergeability\b/i,
  /\beligible\b/i,
  /\bgate\b/i,
  /\bclosure\b/i,
  /\bdispatch\b/i,
  /\bmerge\b/i,
];

const BLOCK_START_RE = /(?:^|\b)(?:export\s+)?(?:async\s+)?(?:function|class|if|for|while|switch|try|catch|else|do)\b|=>\s*\{/;

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, '..');

function usage() {
  return [
    'Usage: node scripts/audit-cdm-rederivation.mjs [--root <repo>] [--scan <path>]... [--out <path>] [--format json] [--strict]',
    '',
    'Flags:',
    '  --root <repo>       Repository root. Default: parent of this script.',
    '  --scan <path>       Relative path to scan. Repeatable. Default: src, scripts, bin.',
    '  --out <path>        Write JSON artifact to path instead of stdout.',
    '  --format json       Output format; json is the only supported value.',
    '  --strict            Exit 1 when non-allowlisted findings exist.',
  ].join('\n');
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    root: DEFAULT_ROOT,
    scans: [],
    out: null,
    format: 'json',
    strict: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    }
    if (arg === '--root') {
      args.root = path.resolve(requireValue(argv, ++i, arg));
    } else if (arg === '--scan') {
      args.scans.push(requireValue(argv, ++i, arg));
    } else if (arg === '--out') {
      args.out = requireValue(argv, ++i, arg);
    } else if (arg === '--format') {
      args.format = requireValue(argv, ++i, arg);
      if (args.format !== 'json') {
        throw new Error(`unsupported --format ${args.format}; only json is supported`);
      }
    } else if (arg === '--strict') {
      args.strict = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function pathWithinRoot(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveScanPaths(root, scans) {
  const rawScans = scans.length ? scans : DEFAULT_SCAN_TARGETS;
  const paths = [];
  for (const raw of rawScans) {
    const resolved = path.resolve(root, raw);
    if (!pathWithinRoot(resolved, root)) {
      throw new Error(`scan target ${raw} resolves outside root ${root}`);
    }
    try {
      statSync(resolved);
    } catch {
      if (scans.length) throw new Error(`scan target ${raw} does not exist under ${root}`);
      continue;
    }
    paths.push(resolved);
  }
  if (!paths.length) {
    throw new Error(`no scan paths exist under ${root}`);
  }
  return paths;
}

function shouldScanFile(filePath, root) {
  const rel = normalizeRel(filePath, root);
  if (rel === OWNER_MODULE) return false;
  if (rel === SELF_MODULE) return false;
  const ext = path.extname(filePath);
  return DEFAULT_INCLUDE_EXTENSIONS.has(ext);
}

function normalizeRel(filePath, root) {
  return path.relative(root, filePath).split(path.sep).join('/');
}

function walkFiles(scanPaths, root) {
  const files = [];
  for (const scanPath of scanPaths) {
    const st = statSync(scanPath);
    if (st.isFile()) {
      if (shouldScanFile(scanPath, root)) files.push(scanPath);
      continue;
    }
    walkDir(scanPath, root, files);
  }
  return files;
}

function walkDir(dir, root, files) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      walkDir(path.join(dir, entry.name), root, files);
      continue;
    }
    if (!entry.isFile()) continue;
    const filePath = path.join(dir, entry.name);
    if (shouldScanFile(filePath, root)) files.push(filePath);
  }
}

function lineMatchesAny(line, patterns) {
  return patterns.some((pattern) => pattern.test(line));
}

function matchingFacts(line) {
  const facts = [];
  for (const [fact, patterns] of Object.entries(FACT_PATTERNS)) {
    if (lineMatchesAny(line, patterns)) facts.push(fact);
  }
  return facts;
}

function markerForLine(line) {
  const match = line.match(ALLOWLIST_MARKER_RE);
  return match ? match[1].trim() : null;
}

function attachedAllowlistReason(lines, lineNumber, matchedLines = []) {
  for (const candidateLine of [lineNumber, previousNonBlankLine(lines, lineNumber)]) {
    if (!candidateLine) continue;
    const reason = markerForLine(lines[candidateLine - 1]);
    if (reason) return reason;
  }
  const spanReason = allowlistReasonInSpan(lines, matchedLines);
  if (spanReason) return spanReason;

  const blockStartLine = enclosingBlockStartLine(lines, lineNumber);
  if (blockStartLine) {
    const blockReason = allowlistReasonBeforeLine(lines, blockStartLine);
    if (blockReason) return blockReason;
  }
  return null;
}

function allowlistReasonInSpan(lines, matchedLines) {
  if (!matchedLines.length) return null;
  const startLine = Math.min(...matchedLines);
  const endLine = Math.max(...matchedLines);
  for (let lineNumber = startLine; lineNumber <= endLine; lineNumber += 1) {
    const reason = markerForLine(lines[lineNumber - 1]);
    if (reason) return reason;
  }
  return null;
}

function allowlistReasonBeforeLine(lines, lineNumber) {
  const previousLine = previousNonBlankLine(lines, lineNumber);
  return previousLine ? markerForLine(lines[previousLine - 1]) : null;
}

function enclosingBlockStartLine(lines, lineNumber) {
  for (let index = lineNumber - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line) continue;
    if (line.includes('{') && BLOCK_START_RE.test(line)) return index + 1;
    if (line.includes('}')) return null;
  }
  return null;
}

function previousNonBlankLine(lines, lineNumber) {
  for (let index = lineNumber - 2; index >= 0; index -= 1) {
    if (lines[index].trim()) return index + 1;
  }
  return null;
}

function scanFile(filePath, root) {
  const rel = normalizeRel(filePath, root);
  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  const lines = text.split(/\r?\n/);
  const interesting = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const facts = matchingFacts(line);
    const decision = lineMatchesAny(line, DECISION_PATTERNS);
    const allowlistReason = markerForLine(line);
    if (facts.length || decision || allowlistReason) {
      interesting.push({
        index,
        line: index + 1,
        text: line,
        facts,
        decision,
        allowlistReason,
      });
    }
  }

  const findings = [];
  const seen = new Set();
  for (const anchor of interesting.filter((item) => item.facts.length || item.decision)) {
    const start = Math.max(0, anchor.index - WINDOW_RADIUS);
    const end = Math.min(lines.length - 1, anchor.index + WINDOW_RADIUS);
    const windowItems = interesting.filter((item) => item.index >= start && item.index <= end);
    const factLines = {
      reviewerHead: [],
      reviewVerdict: [],
      mergeability: [],
    };
    const decisionLines = [];
    for (const item of windowItems) {
      for (const fact of item.facts) {
        factLines[fact].push(item.line);
      }
      if (item.decision) decisionLines.push(item.line);
    }
    if (
      !factLines.reviewerHead.length ||
      !factLines.reviewVerdict.length ||
      !factLines.mergeability.length ||
      !decisionLines.length
    ) {
      continue;
    }
    const findingLine = Math.min(
      ...factLines.reviewerHead,
      ...factLines.reviewVerdict,
      ...factLines.mergeability,
      ...decisionLines,
    );
    const matchedLines = [
      ...factLines.reviewerHead,
      ...factLines.reviewVerdict,
      ...factLines.mergeability,
      ...decisionLines,
    ];
    const key = `${rel}:${findingLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const contextLines = lines
      .slice(Math.max(0, findingLine - 3), Math.min(lines.length, findingLine + 2))
      .map((line) => line.trim())
      .filter(Boolean);
    const allowlistReason = attachedAllowlistReason(lines, findingLine, matchedLines);
    findings.push({
      category: 'review-verdict',
      severity: 'high',
      file: rel,
      line: findingLine,
      match: 'reviewer_head_sha + review verdict source + mergeability + gate decision',
      context: contextLines.join(' ').slice(0, 240),
      facts: {
        reviewerHeadLines: uniqueSorted(factLines.reviewerHead),
        reviewVerdictLines: uniqueSorted(factLines.reviewVerdict),
        mergeabilityLines: uniqueSorted(factLines.mergeability),
        decisionLines: uniqueSorted(decisionLines),
      },
      suggested_owner: OWNER_MODULE,
      suggested_remediation: 'Consume buildAdversarialGateSnapshot()/pickAdversarialGateStatus() instead of combining raw review-gate facts.',
      allowlist_marker_present: allowlistReason !== null,
      ...(allowlistReason ? { allowlist_reason: allowlistReason } : {}),
    });
  }
  return findings;
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((a, b) => a - b);
}

function summary(findings) {
  const byCategory = {};
  const bySeverity = {};
  let allowlisted = 0;
  for (const finding of findings) {
    byCategory[finding.category] = (byCategory[finding.category] || 0) + 1;
    bySeverity[finding.severity] = (bySeverity[finding.severity] || 0) + 1;
    if (finding.allowlist_marker_present) allowlisted += 1;
  }
  return {
    total: findings.length,
    allowlisted,
    non_allowlisted: findings.length - allowlisted,
    by_category: byCategory,
    by_severity: bySeverity,
  };
}

export function runAudit(options = {}) {
  const root = path.resolve(options.root || DEFAULT_ROOT);
  const scanPaths = resolveScanPaths(root, options.scans || []);
  const files = walkFiles(scanPaths, root);
  const findings = files.flatMap((filePath) => scanFile(filePath, root));
  findings.sort((a, b) => (
    a.file.localeCompare(b.file) ||
    a.line - b.line ||
    a.category.localeCompare(b.category)
  ));
  return {
    scanned_paths: scanPaths.map((scanPath) => normalizeRel(scanPath, root)),
    scan_started_at_utc: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    owner_module: OWNER_MODULE,
    allowlist_marker: 'cdm-allowlist',
    summary: summary(findings),
    findings,
  };
}

function main() {
  try {
    const args = parseArgs();
    const report = runAudit({ root: args.root, scans: args.scans });
    const output = `${JSON.stringify(report, null, 2)}\n`;
    if (args.out) {
      writeFileSync(args.out, output, 'utf8');
    } else {
      process.stdout.write(output);
    }
    if (args.strict && report.summary.non_allowlisted > 0) {
      console.error(`[strict] ${report.summary.non_allowlisted} non-allowlisted CDM re-derivation finding(s)`);
      return 1;
    }
    return 0;
  } catch (err) {
    console.error(`error: ${err?.message || err}`);
    return 2;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
