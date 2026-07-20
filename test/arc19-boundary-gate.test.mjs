import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, sep } from 'node:path';
import { parse } from 'acorn';

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
//   R1  Kernel purity      — src/kernel/** may import only node: builtins and
//                            relative modules inside src/kernel/. The kernel is
//                            layer 1 and imports nothing higher or external.
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

function literalSpecifierValue(node) {
  if (!node) return null;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (
    node.type === 'TemplateLiteral'
    && node.expressions.length === 0
    && node.quasis.length === 1
  ) {
    return node.quasis[0].value.cooked;
  }
  return null;
}

function walkAst(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (
      key === 'parent'
      || key === 'start'
      || key === 'end'
      || key === 'loc'
      || key === 'range'
    ) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const child of value) walkAst(child, visit);
    } else if (value && typeof value.type === 'string') {
      walkAst(value, visit);
    }
  }
}

// Extract every imported/re-exported module specifier with the parser rather
// than regex: static imports, re-exports, bare side-effect imports, and literal
// dynamic imports. Comments, strings, and template literals without import
// expression semantics are ignored by construction.
function importSpecifiers(source) {
  const specs = [];
  const ast = parse(source, {
    ecmaVersion: 'latest',
    sourceType: 'module',
    allowHashBang: true,
  });
  walkAst(ast, (node) => {
    if (
      node.type === 'ImportDeclaration'
      || node.type === 'ExportNamedDeclaration'
      || node.type === 'ExportAllDeclaration'
    ) {
      const spec = literalSpecifierValue(node.source);
      if (spec) specs.push(spec);
    } else if (node.type === 'ImportExpression') {
      const spec = literalSpecifierValue(node.source);
      if (spec) specs.push(spec);
    }
  });
  return specs;
}

// Resolve a relative specifier against the importing file's directory. Bare
// specifiers and `node:` builtins return null — callers distinguish the
// permitted builtins from forbidden external packages.
function resolveRelative(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  return join(dirname(fromFile), spec);
}

// R1 predicate: imports other than node: builtins and intra-kernel relatives.
function kernelPurityViolations(file, source) {
  const kernelPrefix = KERNEL + sep;
  return importSpecifiers(source)
    .map((spec) => ({ spec, resolved: resolveRelative(file, spec) }))
    .filter(({ spec, resolved }) => !spec.startsWith('node:') && (
      resolved === null
      || (!`${resolved}${sep}`.startsWith(kernelPrefix) && !resolved.startsWith(kernelPrefix))
    ))
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
  // 6659 -> 6686: SEV0 2026-07-19 codex --model pin (resolveCodexRemediationModel); decomposition will reclaim.
  // 6686 -> 6140: ARC-19 wave3 extract workflow-push-capability preflight to src/remediation-workflow-push-capability.mjs.
  // 6140 -> 5820: ARC-19 wave3 extract git & PR I/O helpers to src/remediation-git-pr-io.mjs.
  // 5820 -> 5582: ARC-19 wave4 extract HQ dispatch status/cancel helpers to src/remediation-hq-dispatch.mjs.
  // 5582 -> 5426: ARC-19 wave4 extract worker-process liveness helpers to src/remediation-worker-liveness.mjs.
  // 5426 -> 5289: ARC-19 wave5 extract remediation orchestration-mode & dispatch-path resolution to src/remediation-dispatch-mode.mjs.
  // 5289 -> 5167: ARC-19 wave5 extract remediation worker prompt builder to src/remediation-prompt-builder.mjs.
  // 5167 -> 5054: ARC-19 wave8 extract claude-code remediation worker spawn/env to src/remediation-claude-code-worker.mjs.
  // 5054 -> 4790: ARC-19 wave10 extract remediation OAuth pre-flight assertions to src/remediation-oauth-preflight.mjs.
  'follow-up-remediation.mjs': 4790,
  // 5485 -> 4262: ARC-19 wave3 extract fast-merge processing/orchestration to src/fast-merge-processing.mjs.
  // 4262 -> 3742: ARC-19 wave3 extract merge-agent dispatch-decision policy to src/merge-agent-dispatch-decision.mjs.
  // 3742 -> 3660: ARC-19 wave4 extract review-state classification to src/merge-agent-review-classification.mjs.
  // 3660 -> 3540: ARC-19 wave5 extract phantom-handoff comment builders/poster to src/merge-agent-phantom-handoff-comment.mjs.
  // 3540 -> 3382: ARC-19 wave7 extract hq executable detection + exec-error classification to src/merge-agent-hq-exec.mjs.
  // 3382 -> 3088: ARC-19 wave9 extract original-worker teardown preflight to src/merge-agent-original-worker-teardown.mjs.
  // 3088 -> 3008: ARC-19 wave11 extract PR candidate fetch + operator-notes builder to src/merge-agent-candidate.mjs.
  'follow-up-merge-agent.mjs': 3008,
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
  // RED — a third-party bare specifier is not a node: builtin.
  assert.deepEqual(
    kernelPurityViolations(kernelFile, "import lodash from 'lodash';\n"),
    ['lodash'],
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
    "const t = await import(`./template-dynamic.mjs`);",
    "const inline = true; import { d } from './inline.mjs';",
    "/* block comment prefix */ import { e } from './block-comment-prefix.mjs';",
    "import { f /* ; */ } from './inline-comment-semicolon.mjs';",
    "// import { fake } from './comment-only.mjs' -- must be ignored",
    "const doc = `import { fake } from './template-string-only.mjs';`;",
  ].join('\n');
  const specs = importSpecifiers(src);
  assert.ok(specs.includes('./a.mjs'));
  assert.ok(specs.includes('./b.mjs'));
  assert.ok(specs.includes('./multiline-import.mjs'));
  assert.ok(specs.includes('./multiline-export.mjs'));
  assert.ok(specs.includes('./side-effect.mjs'));
  assert.ok(specs.includes('./c.mjs'));
  assert.ok(specs.includes('./template-dynamic.mjs'));
  assert.ok(specs.includes('./inline.mjs'));
  assert.ok(specs.includes('./block-comment-prefix.mjs'));
  assert.ok(specs.includes('./inline-comment-semicolon.mjs'));
  assert.ok(!specs.includes('./comment-only.mjs'), 'commented-out imports must not be captured');
  assert.ok(!specs.includes('./template-string-only.mjs'), 'template-string text must not be captured');
});
