import { readFileSync, writeFileSync } from 'node:fs';
import * as module from 'node:module';
import { pathToFileURL } from 'node:url';
import { parse } from 'acorn';

// Rewrite syntax nodes, not text inside fixture module source strings. Keep
// nested async functions intact; only the loader's next-hook calls become sync.
export function synchronousFixtureHooks(source) {
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const edits = [];
  let hooks = 0;
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)) return;
    if (node.type === 'AwaitExpression') {
      if (node.argument.type !== 'CallExpression'
        || !['nextResolve', 'nextLoad'].includes(node.argument.callee.name)) {
        throw new Error('Fixture loader contains an asynchronous operation beyond its next hook');
      }
      edits.push([node.start, node.argument.start]);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  }
  for (const entry of ast.body) {
    const declaration = entry.type === 'ExportNamedDeclaration' && entry.declaration;
    if (declaration?.type !== 'FunctionDeclaration'
      || !['resolve', 'load'].includes(declaration.id?.name)) continue;
    if (!declaration.async || source.slice(declaration.start, declaration.start + 6) !== 'async ') {
      throw new Error('Expected an asynchronous fixture hook declaration');
    }
    hooks++;
    edits.push([declaration.start, declaration.start + 6]);
    visit(declaration.body);
  }
  if (hooks !== 2) throw new Error('Expected both fixture loader hooks');
  for (const [start, end] of edits.sort((a, b) => b[0] - a[0])) {
    source = source.slice(0, start) + source.slice(end);
  }
  return source;
}

// Per-case source overrides are already applied before this adapter runs.
export function buildRegisterSource(loaderPath, { synchronous = true } = {}) {
  if (synchronous && typeof module.registerHooks === 'function') {
    writeFileSync(`${loaderPath}.sync.mjs`, synchronousFixtureHooks(readFileSync(loaderPath, 'utf8')));
  }
  return `
import * as module from 'node:module';

// Synchronous fixture hooks avoid a worker-thread round trip for every import.
// Older Node 22 releases retain the same fixture through asynchronous hooks.
if (${synchronous} && typeof module.registerHooks === 'function') {
  const { resolve, load } = await import(${JSON.stringify(pathToFileURL(`${loaderPath}.sync.mjs`).href)});
  module.registerHooks({ resolve, load });
} else {
  module.register(${JSON.stringify(pathToFileURL(loaderPath).href)}, import.meta.url);
}
`;
}
