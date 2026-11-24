import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'acorn';

const roots = ['src', 'bin', 'scripts', 'test'];
const javascript = /\.(?:cjs|js|mjs)$/;
const executable = /\.(?:cjs|js|mjs|py|sh)$/;
const harnessPaths = new Set(['bin/ci-install.mjs', 'src/node-test-concurrency.mjs']);
const schedulers = new Set(['test/run-tests.mjs', 'test/helpers/parallel-plan.mjs']);
const prose = /^(?:docs\/.*|[^/]+)\.(?:adoc|md|rst|txt)$/i;

export function changedPaths(repoRoot, base) {
  const git = (...args) => execFileSync('git', args, {
    cwd: repoRoot, encoding: 'utf8', timeout: 10_000, maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const baseOid = git('rev-parse', '--verify', '--end-of-options', `${base}^{commit}`).trim();
  const fields = git('diff', '--no-ext-diff', '--no-renames', '--name-status', '-z',
    baseOid, 'HEAD', '--').split('\0');
  if (fields.pop() !== '' || fields.length % 2 !== 0) throw new Error('invalid Git diff');
  const changes = [];
  for (let i = 0; i < fields.length; i += 2) {
    changes.push({ status: fields[i], file: fields[i + 1] });
  }
  return changes;
}

// Build edges from static imports, re-exports and literal dynamic imports.
// Also retain literal source paths used by spawn(), new URL(), file reads and
// embedded fixture scripts. A bare filename covers join(root, 'dir', 'file').
function references(source, file, repoFiles, pathsByName) {
  const dependencies = new Set();
  function add(specifier) {
    if (!specifier) return;
    const clean = specifier.split(/[?#]/, 1)[0];
    if (clean.startsWith('.')) {
      const relative = path.posix.join(path.posix.dirname(file), clean);
      if (repoFiles.has(relative)) dependencies.add(relative);
    }
    if (repoFiles.has(clean)) dependencies.add(clean);
  }
  function addPaths(text) {
    add(text);
    for (const candidate of text.matchAll(/(?:[\w.@-]+\/)*[\w.@-]+\.(?:cjs|js|json|mjs|py|sh)\b/g)) {
      const name = candidate[0];
      if (name.includes('/')) add(name);
      else for (const match of pathsByName.get(name) ?? []) dependencies.add(match);
    }
  }
  function visit(node) {
    if (!node?.type) return;
    if (node.type === 'Literal' && typeof node.value === 'string') addPaths(node.value);
    if (node.type === 'TemplateElement') addPaths(node.value.cooked ?? node.value.raw);
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) child.forEach(visit);
      else visit(child);
    }
  }
  if (javascript.test(file)) {
    visit(parse(source, { ecmaVersion: 'latest', sourceType: file.endsWith('.cjs') ? 'commonjs' : 'module' }));
  } else {
    addPaths(source);
  }
  return dependencies;
}

export function buildReverseGraph(repoRoot) {
  const repoFiles = new Set();
  for (const root of roots) {
    for (const entry of readdirSync(path.join(repoRoot, root), { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) repoFiles.add(path.relative(repoRoot,
        path.join(entry.parentPath, entry.name)).split(path.sep).join('/'));
    }
  }
  const pathsByName = new Map();
  for (const file of repoFiles) {
    const name = path.posix.basename(file);
    if (!pathsByName.has(name)) pathsByName.set(name, []);
    pathsByName.get(name).push(file);
  }
  const graph = new Map();
  for (const file of repoFiles) {
    // Scheduling metadata names test entrypoints to execute. Those references
    // do not make every test depend on the code exercised by those entrypoints.
    if (!executable.test(file) || schedulers.has(file)) continue;
    let dependencies;
    try {
      dependencies = references(readFileSync(path.join(repoRoot, file), 'utf8'), file, repoFiles, pathsByName);
    } catch (error) {
      throw new Error(`cannot scan ${file}: ${error.message}`, { cause: error });
    }
    for (const dependency of dependencies) {
      if (!graph.has(dependency)) graph.set(dependency, new Set());
      graph.get(dependency).add(file);
    }
  }
  return graph;
}

export function selectAffectedTests(files, changes, loadGraph) {
  const tests = new Set(files);
  const inputs = changes.filter(({ file }) => !prose.test(file));
  if (!inputs.length) return { mode: 'none', reason: 'no test inputs changed', files: [] };

  const full = reason => ({ mode: 'full', reason, files });
  for (const { file, status } of inputs) {
    // Deletions and type changes can erase edges from the current checkout.
    // Non-test files under test/ include fixtures, preloads and the runner.
    if (!['A', 'M'].includes(status) || harnessPaths.has(file)
      || (!tests.has(file) && !/^(?:src|bin|scripts)\/.*\.(?:cjs|js|json|mjs|py|sh)$/.test(file))) {
      return full(`shared or unclassified change: ${file}`);
    }
  }

  const graph = loadGraph();
  const selected = new Set();
  for (const { file } of inputs) {
    const reachable = new Set([file]);
    let found = false;
    // Set iteration includes newly added entries, so this also handles cycles.
    for (const dependency of reachable) {
      if (tests.has(dependency)) {
        selected.add(dependency);
        found = true;
      }
      for (const consumer of graph.get(dependency) ?? []) reachable.add(consumer);
    }
    if (!found) return full(`no known test dependency for ${file}`);
  }
  return { mode: 'affected', reason: 'reverse dependency graph', files: files.filter(file => selected.has(file)) };
}

export function planAffectedTests(repoRoot, files, base) {
  let changes;
  try {
    changes = changedPaths(repoRoot, base);
    return { ...selectAffectedTests(files, changes, () => buildReverseGraph(repoRoot)), changes };
  } catch (error) {
    // A shallow checkout, a parser failure or an unreadable graph must never
    // turn a code change into an empty test run.
    const reason = error.message.split('\n', 1)[0];
    return { mode: 'full', reason: `selection unavailable: ${reason}`, files, changes };
  }
}
