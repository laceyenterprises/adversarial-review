import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, sep } from 'node:path';

// ARC-19 import-boundary gate — the ratchet that keeps the v2 five-layer
// architecture from regressing after the ARC pack closes.
//
// Layer model (docs/SPEC-adversarial-review-v2-app-architecture.md §3):
// dependencies point DOWN — a layer may import contracts from any LOWER layer,
// but lower layers never import higher-layer implementations.
//
//   5. Composition + OS integration  (scheduler watcher.mjs, orchestration
//                                      follow-up-*.mjs, runtime impls, SDK)
//   4. Domain adapters               (src/adapters/**: subject/comms/operator/
//                                      reviewer-runtime)
//   3. Agent runtime port
//   2. Foundation                    (role registry, credentials provider)
//   1. Kernel                        (src/kernel/**: pipeline, verdict,
//                                      remediation-reply, prompt-stage)
//
// Enforced rules:
//   R1  Kernel purity      — no src/kernel/** module imports (via a relative
//                            path) anything OUTSIDE src/kernel/. The kernel is
//                            layer 1 and imports nothing higher.
//   R2  No upward import    — neither src/kernel/** nor src/adapters/** imports
//                            the layer-5 scheduler/orchestration monoliths
//                            (watcher.mjs, follow-up-remediation.mjs,
//                            follow-up-merge-agent.mjs).
//   R3  Monolith ratchets   — the two orchestration monoliths' line counts are
//                            decrease-only.
//
// Scope note: adapters importing kernel modules (e.g. verdict.mjs) is NOT a
// violation — that is a legal downward import of lower-layer contracts per §3.
// A lexical ban on concrete-system NAMES inside the kernel (verdict.mjs's
// markdown/Codex review-format handling) is deliberately out of scope here: the
// review format is a genuine shared-kernel concern, and ARC-19's mandate is the
// IMPORT boundary. See test/arc18-decomposition-gates.test.mjs for the
// watcher-specific decomposition gates this complements.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, '..', 'src');
const KERNEL = join(SRC, 'kernel');
const ADAPTERS = join(SRC, 'adapters');

// Layer-5 scheduler + orchestration modules that lower layers must never import.
const ORCHESTRATION_MONOLITHS = Object.freeze([
  join(SRC, 'watcher.mjs'),
  join(SRC, 'follow-up-remediation.mjs'),
  join(SRC, 'follow-up-merge-agent.mjs'),
]);

function allMjs(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) allMjs(p, acc);
    else if (name.endsWith('.mjs')) acc.push(p);
  }
  return acc;
}

// Extract every imported/re-exported module specifier: `import ... from 'x'`,
// `export ... from 'x'`, bare `import 'x'`, and dynamic `import('x')`. Ignores
// specifiers that appear only in comments/strings by requiring import/export
// keyword context.
function importSpecifiers(source) {
  const specs = [];
  for (const m of source.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s*['"]([^'"]+)['"]/g)) {
    specs.push(m[1]);
  }
  for (const m of source.matchAll(/(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g)) {
    specs.push(m[1]);
  }
  for (const m of source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    specs.push(m[1]);
  }
  return specs;
}

// Resolve a relative specifier against the importing file's directory. Bare
// specifiers (npm packages) and `node:` builtins return null — they are not
// intra-repo layer imports.
function resolveRelative(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  return join(dirname(fromFile), spec);
}

// R1 predicate: relative imports from a kernel file that escape src/kernel/.
function kernelPurityViolations(file, source) {
  const kernelPrefix = KERNEL + sep;
  return importSpecifiers(source)
    .map((spec) => ({ spec, resolved: resolveRelative(file, spec) }))
    .filter(({ resolved }) => resolved !== null && !`${resolved}${sep}`.startsWith(kernelPrefix) && !resolved.startsWith(kernelPrefix))
    .map(({ spec }) => spec);
}

// R2 predicate: imports (from any file) that resolve to an orchestration monolith.
function orchestrationImportViolations(file, source) {
  const targets = new Set(ORCHESTRATION_MONOLITHS);
  return importSpecifiers(source)
    .map((spec) => ({ spec, resolved: resolveRelative(file, spec) }))
    .filter(({ resolved }) => resolved !== null && targets.has(resolved))
    .map(({ spec }) => spec);
}

// ── R1: kernel purity ────────────────────────────────────────────────────────
test('ARC-19 R1: src/kernel/** imports nothing outside src/kernel/', () => {
  const offenders = [];
  for (const file of allMjs(KERNEL)) {
    for (const spec of kernelPurityViolations(file, readFileSync(file, 'utf8'))) {
      offenders.push(`${file.slice(SRC.length + 1)} → ${spec}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `Kernel (layer 1) must import only node: builtins and other src/kernel/** modules. `
      + `Move the shared code down into the kernel or the dependency up out of it:\n  ${offenders.join('\n  ')}`,
  );
});

// ── R2: no upward import into the scheduler/orchestration monoliths ───────────
test('ARC-19 R2: src/kernel/** and src/adapters/** never import the orchestration monoliths', () => {
  const offenders = [];
  for (const file of [...allMjs(KERNEL), ...allMjs(ADAPTERS)]) {
    for (const spec of orchestrationImportViolations(file, readFileSync(file, 'utf8'))) {
      offenders.push(`${file.slice(SRC.length + 1)} → ${spec}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `Layer 1/4 modules must not import the layer-5 scheduler/orchestration `
      + `(watcher.mjs, follow-up-remediation.mjs, follow-up-merge-agent.mjs). `
      + `Inject the dependency from the composition root (watcher.mjs) behind a port instead:\n  ${offenders.join('\n  ')}`,
  );
});

// ── R3: monolith line-count ratchets (decrease-only) ─────────────────────────
const MONOLITH_CEILINGS = Object.freeze({
  'follow-up-remediation.mjs': 7691,
  'follow-up-merge-agent.mjs': 5989,
});

for (const [name, ceiling] of Object.entries(MONOLITH_CEILINGS)) {
  test(`ARC-19 R3: ${name} stays at or below ${ceiling} lines (decrease-only)`, () => {
    const lines = readFileSync(join(SRC, name), 'utf8').split('\n').length;
    assert.ok(
      lines <= ceiling,
      `${name} has ${lines} lines, above the ${ceiling}-line ratchet. `
        + `Fold code into kernel effects / adapters and LOWER this ceiling; never raise it.`,
    );
  });
}

// ── Red/green fixtures: prove the gate logic catches violations and passes clean.
test('ARC-19 gate fixtures: kernel-purity predicate is red on escape, green on intra-kernel', () => {
  const kernelFile = join(KERNEL, '__fixture__.mjs');
  // GREEN — node: builtin + intra-kernel relative import.
  assert.deepEqual(
    kernelPurityViolations(kernelFile, "import { readFileSync } from 'node:fs';\nimport { x } from './verdict.mjs';\n"),
    [],
  );
  // RED — a relative import that escapes src/kernel/.
  assert.deepEqual(
    kernelPurityViolations(kernelFile, "import { apiStatusFromError } from '../api-telemetry.mjs';\n"),
    ['../api-telemetry.mjs'],
  );
});

test('ARC-19 gate fixtures: orchestration-import predicate is red on monolith, green otherwise', () => {
  const adapterFile = join(ADAPTERS, 'subject', 'github-pr', '__fixture__.mjs');
  // GREEN — importing a sibling adapter helper + a kernel module (legal downward).
  assert.deepEqual(
    orchestrationImportViolations(
      adapterFile,
      "import { x } from './routing.mjs';\nimport { normalizeReviewVerdict } from '../../../kernel/verdict.mjs';\n",
    ),
    [],
  );
  // RED — reaching up into the follow-up-remediation orchestration monolith.
  assert.deepEqual(
    orchestrationImportViolations(
      adapterFile,
      "import { prepareWorkspaceForJob } from '../../../follow-up-remediation.mjs';\n",
    ),
    ['../../../follow-up-remediation.mjs'],
  );
});

test('ARC-19 gate fixtures: importSpecifiers captures static, re-export, bare, and dynamic forms', () => {
  const src = [
    "import a from './a.mjs';",
    "export { b } from './b.mjs';",
    "import {",
    "  multilineImport,",
    "} from './multiline-import.mjs';",
    "export {",
    "  multilineExport,",
    "} from './multiline-export.mjs';",
    "import './side-effect.mjs';",
    "const c = await import('./c.mjs');",
    "// import { fake } from './comment-only.mjs' -- must be ignored",
  ].join('\n');
  const specs = importSpecifiers(src);
  assert.ok(specs.includes('./a.mjs'));
  assert.ok(specs.includes('./b.mjs'));
  assert.ok(specs.includes('./multiline-import.mjs'));
  assert.ok(specs.includes('./multiline-export.mjs'));
  assert.ok(specs.includes('./side-effect.mjs'));
  assert.ok(specs.includes('./c.mjs'));
  assert.ok(!specs.includes('./comment-only.mjs'), 'commented-out imports must not be captured');
});
