import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, basename, posix } from 'node:path';

// Resolve repository-owned runners, never synthesize pytest or PYTHONPATH.
export function canonicalHammerValidation(root, changedFiles, { node = process.execPath } = {}) {
  if (!changedFiles.length) return null;
  if (changedFiles.some(file => typeof file !== 'string'
    || file.startsWith('-') || file.startsWith('/') || file.split('/').includes('..'))) {
    throw new TypeError('canonical validation requires repository-relative changed files');
  }
  if (existsSync(join(root, 'scripts/ci-mirror/run-ci-mirror.py'))) {
    return { command: 'python3', args: ['scripts/ci-mirror/run-ci-mirror.py', '--', ...changedFiles] };
  }
  let pkg;
  try { pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')); } catch { /* Unsupported runner. */ }
  if (pkg?.name !== 'adversarial-review') return null;
  const tests = ['test', 'test/adapters'].flatMap(dir => existsSync(join(root, dir))
    ? readdirSync(join(root, dir)).filter(file => file.endsWith('.test.mjs')).map(file => `${dir}/${file}`) : []);
  const selected = tests.filter(file => {
    if (changedFiles.includes(file)) return true;
    const source = readFileSync(join(root, file), 'utf8');
    return changedFiles.some(changed => {
      const relative = posix.relative(posix.dirname(file), changed);
      const specifier = relative.startsWith('../') ? relative : `./${relative}`;
      return basename(changed).replace(/\.mjs$/, '.test.mjs') === basename(file)
        || source.includes(specifier);
    });
  });
  return selected.length ? { command: node, args: ['test/run-tests.mjs', ...selected] } : null;
}

export function repositoryPythonPackages(root) {
  const names = new Set();
  const collect = dir => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(dir, entry.name, '__init__.py'))) names.add(entry.name);
    }
  };
  collect(root);
  collect(join(root, 'src'));
  for (const parent of ['modules', 'platform']) {
    const dir = join(root, parent);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      collect(join(dir, entry.name, 'src'));
      collect(join(dir, entry.name, 'lib/python'));
    }
  }
  return names;
}

export function ownPackageImportFault(output, packages) {
  const missing = [...output.matchAll(/(?:ModuleNotFoundError|ImportError): No module named ['"]([A-Za-z_]\w*)(?:\.[^'"]*)?['"]/g)];
  return missing.some(match => packages.has(match[1]));
}
