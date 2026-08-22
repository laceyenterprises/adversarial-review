/**
 * The self-containment guard (ARF-01 acceptance).
 *
 * SPEC §2 / §9: ARF must run as a fully standalone app outside the OS, with
 * **zero agent-os runtime dependency** — it talks only to its own store and (in
 * later tickets) GitHub. That boundary is easy to state and easy to erode: one
 * `import` of a shared helper for "just this one thing" and the standalone build
 * stops being a clean bundle boundary.
 *
 * So it is asserted mechanically, over every source file under `frontend`:
 *
 *   1. No bare specifiers except `node:` builtins — that means no npm
 *      dependency and no agent-os package, by construction.
 *   2. No relative specifier that escapes `frontend`.
 *   3. No pipeline runtime root (`modules/`, `platform/`, `runtime/`, `tools/`)
 *      named in any specifier, however it is spelled.
 *
 * This test scans `frontend` as a whole, not just `server/`, so it keeps
 * covering the frontend and supervisor trees that later tickets add.
 *
 * ARF-08 widens it in two directions the JavaScript scan could not see: every
 * `package.json` under `frontend` rather than the server's alone, and the
 * Python gate client, which the auto-merge backstop honours and which must
 * therefore be droppable into a pipeline repo with nothing to install.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

// test -> server -> frontend
const ARF_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const SOURCE_EXTENSIONS = new Set(['.mjs', '.js', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage']);

/** Runtime roots an ARF file must never reach into. */
const PIPELINE_RUNTIME_ROOTS = ['modules/', 'platform/', 'runtime/', 'tools/'];

/** Agent-os packages that would each be a specific boundary breach. */
const AGENT_OS_PACKAGE_MARKERS = [
  '@agent-os/', 'agent-os-config', 'cwp_dispatch', 'cwp_operator_console',
  'session-ledger', 'session_ledger', 'adversarial-review', 'worker-pool',
];

// All three JS string quotes. `\x60` is a backtick, spelled as an escape so the
// class can live inside a template literal without ambiguity. Template literals
// count: `import(\`@agent-os/app-sdk\`)` is a real dynamic import, and a guard
// that only knew about ' and " would wave it straight through.
const QUOTE = String.raw`['"\x60]`;
const NOT_QUOTE = String.raw`[^'"\x60\n]`;

/**
 * Every module specifier in a source file: static imports, `export ... from`,
 * dynamic `import()`, and `require()`. Only real import syntax matches, so a
 * path mentioned in a comment or a string is not a false positive. The opening
 * quote is captured and back-referenced so a specifier must close with the same
 * quote it opened with. That makes the capture groups (quote, specifier) per
 * branch — groups 1/2 and 3/4 — which `specifiers()` reads.
 */
const SPECIFIER_PATTERN = new RegExp(
  [
    // import x from '...' | import '...' | export ... from '...'
    String.raw`(?:^|[\s;}])(?:import|export)\s*(?:[\w*{}\n\r\t, $]*?\s*from\s*)?(${QUOTE})(${NOT_QUOTE}+)\1`,
    // import('...') and require('...')
    String.raw`(?:^|[^\w.$])(?:import|require)\s*\(\s*(${QUOTE})(${NOT_QUOTE}+)\3\s*\)`,
  ].join('|'),
  // A module specifier never spans a newline; excluding one from the capture
  // stops a quoted string elsewhere in the file from pairing across lines.
  'gm',
);

// This file is excluded from its own scan: it quotes forbidden specifiers as
// negative-control samples, which any honest scanner has to flag. The two
// "detects a violation" / "recognises the import forms" cases below are what
// guard the guard.
const SELF = fileURLToPath(import.meta.url);

/**
 * Files under `dir` that `accept` selects, skipping the usual noise directories.
 */
function walk(dir, accept, found = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, accept, found);
    else if (accept(entry, path)) found.push(path);
  }
  return found;
}

function sourceFiles(dir) {
  return walk(dir, (entry, path) => SOURCE_EXTENSIONS.has(extname(entry)) && path !== SELF);
}

function packageManifests(dir) {
  return walk(dir, (entry) => entry === 'package.json');
}

function pythonFiles(dir) {
  return walk(dir, (entry) => extname(entry) === '.py');
}

/** `import x` / `import x.y` / `from x import ...`, at the start of a line. */
const PYTHON_IMPORT_PATTERN = /^\s*(?:import\s+([\w.]+)|from\s+([\w.]+)\s+import)/gm;

/** The standard-library modules ARF's Python is allowed to reach for. */
const PYTHON_STDLIB = new Set(['argparse', 'json', 'os', 'sys']);

/** ARF's own Python modules, reachable from a sibling through a path insert. */
const ARF_PYTHON_MODULES = new Set(['arf_gate']);

function specifiers(source) {
  const found = [];
  for (const match of source.matchAll(SPECIFIER_PATTERN)) {
    // Groups 1/3 are the quote characters; 2/4 are the specifiers they wrap.
    const specifier = match[2] ?? match[4];
    if (specifier) found.push(specifier);
  }
  return found;
}

const FILES = sourceFiles(ARF_ROOT);

describe('frontend self-containment', () => {
  it('has source files to check', () => {
    // A guard that silently scans nothing passes forever.
    assert.ok(FILES.length > 0, `no source files found under ${ARF_ROOT}`);
  });

  it('imports zero agent-os runtime packages', () => {
    const violations = [];
    for (const file of FILES) {
      const rel = relative(ARF_ROOT, file);
      for (const specifier of specifiers(readFileSync(file, 'utf8'))) {
        const isRelative = specifier.startsWith('./') || specifier.startsWith('../');

        if (!isRelative && !specifier.startsWith('node:')) {
          violations.push(
            `${rel}: bare specifier "${specifier}" — ARF may import only node: builtins`,
          );
          continue;
        }

        if (isRelative) {
          const target = resolve(dirname(file), specifier);
          if (relative(ARF_ROOT, target).startsWith('..')) {
            violations.push(`${rel}: relative import "${specifier}" escapes frontend`);
            continue;
          }
        }

        const normalized = specifier.replace(/\\/g, '/').toLowerCase();
        for (const root of PIPELINE_RUNTIME_ROOTS) {
          if (normalized.includes(`/${root}`) || normalized.startsWith(root)) {
            violations.push(`${rel}: import "${specifier}" reaches into pipeline ${root}`);
          }
        }
        for (const marker of AGENT_OS_PACKAGE_MARKERS) {
          if (normalized.includes(marker)) {
            violations.push(`${rel}: import "${specifier}" pulls in agent-os "${marker}"`);
          }
        }
      }
    }
    assert.deepEqual(violations, [], `frontend must be self-contained:\n${violations.join('\n')}`);
  });

  it('declares no runtime or dev dependencies, in any package under frontend', () => {
    // The import scan cannot see a dependency that is declared but not yet
    // imported; the manifest closes that gap. Every manifest is checked rather
    // than the server's alone — the frontend and supervisor packages are
    // siblings, and a boundary enforced for one package and not its siblings is
    // not enforced.
    const manifests = packageManifests(ARF_ROOT);
    assert.ok(manifests.length >= 2, `expected several package.json files, found ${manifests.length}`);
    for (const path of manifests) {
      const pkg = JSON.parse(readFileSync(path, 'utf8'));
      assert.deepEqual(pkg.dependencies ?? {}, {}, `${relative(ARF_ROOT, path)} declares dependencies`);
      assert.deepEqual(pkg.devDependencies ?? {}, {}, `${relative(ARF_ROOT, path)} declares devDependencies`);
    }
  });

  it('imports only the standard library from its Python client', () => {
    // `gate/arf_gate.py` is honoured by the Python auto-merge backstop, so it
    // has the same boundary as the rest of ARF for the same reason: it must be
    // droppable into a pipeline repo with nothing to install. A guard that only
    // scanned JavaScript would not have noticed.
    const violations = [];
    for (const file of pythonFiles(ARF_ROOT)) {
      const rel = relative(ARF_ROOT, file);
      for (const match of readFileSync(file, 'utf8').matchAll(PYTHON_IMPORT_PATTERN)) {
        const module = (match[1] ?? match[2]).split('.')[0];
        if (PYTHON_STDLIB.has(module)) continue;
        // A sibling ARF module reached through a path insert is still inside
        // frontend, which is what the boundary is about.
        if (ARF_PYTHON_MODULES.has(module)) continue;
        violations.push(`${rel}: imports "${module}", which is neither stdlib nor an ARF module`);
      }
    }
    assert.deepEqual(violations, [], violations.join('\n'));
  });

  it('detects a violation when one is introduced', () => {
    // Proves the scanner actually matches import syntax — a guard whose regex
    // silently stopped matching would pass just as quietly.
    const sample = [
      "import { thing } from '@agent-os/app-sdk';",
      "import helper from '../../../modules/worker-pool/lib/x.mjs';",
      "const y = require('better-sqlite3');",
      "await import('../../platform/session-ledger/index.mjs');",
    ].join('\n');
    assert.deepEqual(specifiers(sample), [
      '@agent-os/app-sdk',
      '../../../modules/worker-pool/lib/x.mjs',
      'better-sqlite3',
      '../../platform/session-ledger/index.mjs',
    ]);
  });

  it('sees specifiers written as template literals', () => {
    // A backtick is a legal quote for a static import and for `import()`, so a
    // scanner blind to it would let the boundary be crossed in silence.
    const sample = [
      'import { thing } from `@agent-os/app-sdk`;',
      'await import(`../../modules/worker-pool/lib/x.mjs`);',
    ].join('\n');
    assert.deepEqual(specifiers(sample), [
      '@agent-os/app-sdk',
      '../../modules/worker-pool/lib/x.mjs',
    ]);
  });

  it('does not pair a specifier across mismatched quotes', () => {
    assert.deepEqual(specifiers('import x from \'@agent-os/app-sdk`;'), []);
  });

  it('still recognises the import forms this codebase uses', () => {
    const sample = [
      "import assert from 'node:assert/strict';",
      "import { a, b } from './local.mjs';",
      "import './side-effect.mjs';",
      "export { c } from './other.mjs';",
      "export * from './star.mjs';",
    ].join('\n');
    assert.deepEqual(specifiers(sample), [
      'node:assert/strict',
      './local.mjs',
      './side-effect.mjs',
      './other.mjs',
      './star.mjs',
    ]);
  });
});
