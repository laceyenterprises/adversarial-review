#!/usr/bin/env node
/**
 * Print the macOS TCC subjects (binaries that the OS prompts about for Full
 * Disk Access) the production review and remediation code paths will exec.
 * The paths are derived directly from those code paths — never hand-edited
 * doc snippets — so the operator approves the binary the daemon will
 * actually exec, not a path that drifted between docs and code.
 *
 * Two distinct production spawn flows touch protected user data, and they
 * resolve their CLI entrypoints DIFFERENTLY:
 *
 *   1. First-pass review (src/reviewer.mjs)
 *      - claude:  hardcoded CLAUDE_CLI  ← imported from reviewer.mjs
 *      - codex:   hardcoded CODEX_CLI   ← imported from reviewer.mjs
 *      The reviewer is launched by the watcher LaunchAgent; its env is the
 *      operator's launchd env, NOT the remediation env contract.
 *
 *   2. Remediation worker (src/follow-up-remediation.mjs)
 *      - claude:  resolveClaudeCodeCliPath() — $CLAUDE_CODE_CLI_PATH > $CLAUDE_CLI > 'claude'
 *      - codex:   resolveCodexCliPath()      — $CODEX_CLI_PATH > $CODEX_CLI > 'codex'
 *      Spawned with `buildInheritedPath()` prepending /opt/homebrew/bin etc.,
 *      so the 'codex' / 'claude' fallback resolves through that PATH at exec
 *      time — NOT through the caller's interactive shell PATH.
 *
 * For each codex CLI entrypoint we follow the codex.js launcher to the real
 * Mach-O binary inside the platform sub-package; that binary, not the
 * user-facing `codex` symlink, is the actual TCC subject. claude is itself a
 * Mach-O so its resolved path is the TCC subject directly.
 *
 * Usage:
 *   node scripts/print-tcc-targets.mjs            # human-readable
 *   node scripts/print-tcc-targets.mjs --json     # machine-readable
 *
 * Run this in the same env the daemon will see at spawn time. If you run it
 * from a different shell with different env vars, set CODEX_CLI_PATH /
 * CLAUDE_CODE_CLI_PATH explicitly to the values your daemon has — otherwise
 * the remediation column reflects YOUR shell, not the daemon's exec env.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import {
  buildInheritedPath,
  resolveCodexCliPath,
  resolveClaudeCodeCliPath,
} from '../src/follow-up-remediation.mjs';
import { CLAUDE_CLI, CODEX_CLI } from '../src/reviewer.mjs';

function whichInPath(executable, path) {
  if (executable.includes('/')) {
    return existsSync(executable) ? resolve(executable) : null;
  }
  for (const dir of String(path).split(':').filter(Boolean)) {
    const candidate = join(dir, executable);
    if (existsSync(candidate)) {
      try {
        return realpathSync(candidate);
      } catch {
        return candidate;
      }
    }
  }
  return null;
}

function deriveCodexMachOPath(codexEntrypoint) {
  if (!codexEntrypoint || !existsSync(codexEntrypoint)) {
    return {
      ok: false,
      reason: codexEntrypoint
        ? `entrypoint does not exist on disk: ${codexEntrypoint}`
        : 'entrypoint could not be resolved',
    };
  }

  let realScript;
  try {
    realScript = realpathSync(codexEntrypoint);
  } catch (err) {
    return { ok: false, reason: `readlink failed for ${codexEntrypoint}: ${err.message}` };
  }

  // The user-facing `codex` symlink resolves to a node script that
  // spawns the real Mach-O binary buried inside the platform sub-package.
  // The script's bin/ dir is sibling to node_modules/, so go up one level
  // and into the platform sub-package's vendor tree.
  const arm = process.arch === 'arm64';
  const triple = arm ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  const subPkg = arm ? 'codex-darwin-arm64' : 'codex-darwin-x64';
  const machO = join(
    dirname(realScript),
    '..',
    'node_modules',
    '@openai',
    subPkg,
    'vendor',
    triple,
    'codex',
    'codex'
  );

  if (!existsSync(machO)) {
    return {
      ok: false,
      reason: `expected Mach-O missing at ${machO} (codex package layout may have changed)`,
    };
  }

  return { ok: true, scriptEntrypoint: realScript, machO: resolve(machO) };
}

function resolveClaudeMachOPath(claudeEntrypoint) {
  if (!claudeEntrypoint || !existsSync(claudeEntrypoint)) {
    return {
      ok: false,
      reason: claudeEntrypoint
        ? `entrypoint does not exist on disk: ${claudeEntrypoint}`
        : 'entrypoint could not be resolved',
    };
  }
  try {
    return { ok: true, machO: realpathSync(claudeEntrypoint) };
  } catch (err) {
    return { ok: false, reason: `readlink failed: ${err.message}` };
  }
}

function resolveNodeMachOPath() {
  // The daemon and watcher both exec node from /opt/homebrew/bin/node by
  // virtue of buildInheritedPath() prepending /opt/homebrew/bin to PATH.
  // Report the same path so an operator can approve it once.
  const node = '/opt/homebrew/bin/node';
  if (!existsSync(node)) {
    return { ok: false, reason: `node not found at ${node}` };
  }
  try {
    return { ok: true, entrypoint: node, machO: realpathSync(node) };
  } catch (err) {
    return { ok: false, reason: `readlink failed: ${err.message}` };
  }
}

function describeReviewerCodex() {
  const entrypoint = CODEX_CLI;
  const machO = deriveCodexMachOPath(entrypoint);
  return {
    flow: 'first-pass-review',
    binary: 'codex',
    sourceOfTruth: 'src/reviewer.mjs::CODEX_CLI (hardcoded)',
    configuredEntrypoint: entrypoint,
    ...machO,
  };
}

function describeReviewerClaude() {
  const entrypoint = CLAUDE_CLI;
  const claude = resolveClaudeMachOPath(entrypoint);
  return {
    flow: 'first-pass-review',
    binary: 'claude',
    sourceOfTruth: 'src/reviewer.mjs::CLAUDE_CLI (hardcoded)',
    configuredEntrypoint: entrypoint,
    ...claude,
  };
}

function describeRemediationCodex() {
  const configured = resolveCodexCliPath();
  const workerPath = buildInheritedPath(process.env.PATH);
  const resolved = configured.includes('/') ? configured : whichInPath(configured, workerPath);
  const machO = deriveCodexMachOPath(resolved);
  return {
    flow: 'remediation-worker',
    binary: 'codex',
    sourceOfTruth:
      'src/follow-up-remediation.mjs::resolveCodexCliPath ($CODEX_CLI_PATH > $CODEX_CLI > codex on inherited PATH)',
    configuredEntrypoint: configured,
    workerInheritedPath: workerPath,
    resolvedEntrypoint: resolved,
    ...machO,
  };
}

function describeRemediationClaude() {
  const configured = resolveClaudeCodeCliPath();
  const workerPath = buildInheritedPath(process.env.PATH);
  const resolved = configured.includes('/') ? configured : whichInPath(configured, workerPath);
  const claude = resolveClaudeMachOPath(resolved);
  return {
    flow: 'remediation-worker',
    binary: 'claude',
    sourceOfTruth:
      'src/follow-up-remediation.mjs::resolveClaudeCodeCliPath ($CLAUDE_CODE_CLI_PATH > $CLAUDE_CLI > claude on inherited PATH)',
    configuredEntrypoint: configured,
    workerInheritedPath: workerPath,
    resolvedEntrypoint: resolved,
    ...claude,
  };
}

function describeNode() {
  const node = resolveNodeMachOPath();
  return {
    flow: 'shared',
    binary: 'node',
    sourceOfTruth:
      "/opt/homebrew/bin/node — execPath the watcher and daemon process; remediation worker's spawned `codex.js` script runs under this node via shebang since /opt/homebrew/bin is first on PATH",
    ...node,
  };
}

function emitTable(targets) {
  const lines = [];
  for (const target of targets) {
    lines.push('');
    lines.push(`flow:                ${target.flow}`);
    lines.push(`binary:              ${target.binary}`);
    lines.push(`source of truth:     ${target.sourceOfTruth}`);
    if (target.configuredEntrypoint !== undefined) {
      lines.push(`configured entrypoint: ${target.configuredEntrypoint}`);
    }
    if (target.workerInheritedPath) {
      lines.push(`worker PATH:         ${target.workerInheritedPath}`);
    }
    if (target.resolvedEntrypoint && target.resolvedEntrypoint !== target.configuredEntrypoint) {
      lines.push(`resolved entrypoint: ${target.resolvedEntrypoint}`);
    }
    if (target.scriptEntrypoint) {
      lines.push(`real script path:    ${target.scriptEntrypoint}`);
    }
    if (target.entrypoint && !target.configuredEntrypoint) {
      lines.push(`entrypoint:          ${target.entrypoint}`);
    }
    if (target.machO) {
      lines.push(`TCC subject (Mach-O): ${target.machO}`);
    }
    if (!target.ok && target.reason) {
      lines.push(`ERROR: ${target.reason}`);
    }
  }
  return lines.join('\n');
}

function main() {
  const json = process.argv.includes('--json');
  const targets = [
    describeNode(),
    describeReviewerClaude(),
    describeReviewerCodex(),
    describeRemediationClaude(),
    describeRemediationCodex(),
  ];

  if (json) {
    process.stdout.write(`${JSON.stringify({ targets }, null, 2)}\n`);
    if (targets.some((t) => t.ok === false)) process.exit(2);
    return;
  }

  const machOForApproval = new Set();
  for (const t of targets) {
    if (t.ok && t.machO) machOForApproval.add(t.machO);
  }

  process.stdout.write('macOS TCC subjects derived from production code paths\n');
  process.stdout.write('=====================================================\n');
  process.stdout.write(emitTable(targets));
  process.stdout.write('\n\n');
  process.stdout.write('Distinct TCC subjects (the binaries to approve, if you choose FDA):\n');
  for (const path of machOForApproval) {
    process.stdout.write(`  - ${path}\n`);
  }
  process.stdout.write('\n');
  process.stdout.write(
    'IMPORTANT: granting Full Disk Access to these binaries expands the trust\n' +
      'boundary — both spawn flows already exec with bypass-style approvals on\n' +
      'untrusted PR content. Prefer running this stack on an isolated worker\n' +
      'account or VM and constraining FDA there. See docs/MACOS-TCC.md.\n'
  );

  if (targets.some((t) => t.ok === false)) {
    process.stderr.write('\nOne or more targets could not be resolved (see ERROR rows above).\n');
    process.exit(2);
  }
}

main();
