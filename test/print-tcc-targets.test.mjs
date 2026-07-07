import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { deriveCodexMachOPath } from '../scripts/print-tcc-targets.mjs';

const arm = process.arch === 'arm64';
const TRIPLE = arm ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
const SUBPKG = arm ? 'codex-darwin-arm64' : 'codex-darwin-x64';

test('cask install form: symlink resolves directly to the Mach-O (no vendor tree)', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'tcc-codex-cask-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // Homebrew cask layout: Caskroom/codex/<ver>/codex-<triple> is the real
  // Mach-O; /opt/homebrew/bin/codex is a symlink pointing straight at it.
  const caskDir = join(root, 'Caskroom', 'codex', '1.2.3');
  mkdirSync(caskDir, { recursive: true });
  const realBinary = join(caskDir, `codex-${TRIPLE}`);
  writeFileSync(realBinary, '#!/bin/echo mach-o\n');
  const binDir = join(root, 'bin');
  mkdirSync(binDir, { recursive: true });
  const symlink = join(binDir, 'codex');
  symlinkSync(realBinary, symlink);

  const result = deriveCodexMachOPath(symlink);
  assert.equal(result.ok, true, result.reason);
  // The resolved entrypoint IS the Mach-O — no node_modules/vendor tree exists.
  // (realpathSync normalizes the macOS /var -> /private/var tmpdir symlink.)
  assert.equal(result.machO, realpathSync(realBinary));
  assert.equal(result.scriptEntrypoint, realpathSync(realBinary));
});

test('npm package form: Mach-O is found under node_modules vendor tree', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'tcc-codex-npm-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // npm layout: bin/codex is the entrypoint; the platform sub-package's
  // vendored Mach-O lives at ../node_modules/@openai/<subpkg>/vendor/<triple>/codex/codex.
  const pkgRoot = join(root, 'pkg');
  const binDir = join(pkgRoot, 'bin');
  mkdirSync(binDir, { recursive: true });
  const entrypoint = join(binDir, 'codex');
  writeFileSync(entrypoint, '#!/usr/bin/env node\n');
  const vendorCodex = join(
    pkgRoot,
    'node_modules',
    '@openai',
    SUBPKG,
    'vendor',
    TRIPLE,
    'codex',
    'codex',
  );
  mkdirSync(dirname(vendorCodex), { recursive: true });
  writeFileSync(vendorCodex, '#!/bin/echo mach-o\n');

  const result = deriveCodexMachOPath(entrypoint);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.machO, realpathSync(vendorCodex));
});

test('missing entrypoint resolves to ok:false', () => {
  const result = deriveCodexMachOPath('/nonexistent/path/to/codex');
  assert.equal(result.ok, false);
  assert.match(result.reason, /does not exist/);
});
