import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'acorn';

for (const [name, config, expected] of [
  ['missing file', undefined, 300_000],
  ['invalid JSON', '{broken', 300_000],
  ['missing interval', '{}', 300_000],
  ['null interval', '{"pollIntervalMs":null}', 300_000],
  ['configured interval', '{"pollIntervalMs":900000}', 900_000],
]) {
  test(`reservation poll default imports with ${name}`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'watcher-poll-config-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, 'src'));
    const modulePath = join(root, 'src', 'watcher-poll-interval.mjs');
    cpSync(new URL('../src/watcher-poll-interval.mjs', import.meta.url), modulePath);
    if (config !== undefined) writeFileSync(join(root, 'config.json'), config);
    const { WATCHER_POLL_INTERVAL_MS } = await import(pathToFileURL(modulePath).href);
    assert.equal(WATCHER_POLL_INTERVAL_MS, expected);
  });
}

test('watcher main gives its runtime interval precedence over the reservation fallback', () => {
  // Execute the production initializer without booting the daemon or its APIs.
  const source = readFileSync(new URL('../src/watcher.mjs', import.meta.url), 'utf8');
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const main = ast.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'main');
  const interval = main.body.body.flatMap(node => node.type === 'VariableDeclaration' ? node.declarations : [])
    .find(node => node.id.name === 'intervalMs');
  const resolve = new Function('config', 'WATCHER_POLL_INTERVAL_MS',
    `return (${source.slice(interval.init.start, interval.init.end)});`);
  assert.equal(resolve({ pollIntervalMs: 900_000 }, 300_000), 900_000);
  assert.equal(resolve({ pollIntervalMs: 60_000 }, 300_000), 60_000);
  assert.equal(resolve({}, 300_000), 300_000);
  assert.equal(resolve({ pollIntervalMs: null }, 120_000), 120_000);
});
