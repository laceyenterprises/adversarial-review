import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, AgentOSConfigError } from '../src/config-loader.mjs';

function fixture(body, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'apple-schema-'));
  const topPath = join(dir, 'config.yaml');
  try {
    writeFileSync(topPath, `version: 1\n${body}`);
    fn(topPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('Apple developer directory defaults to empty with or without the section', () => {
  for (const body of ['', 'apple: {}\n', 'apple:\n  developer_dir: ""\n']) {
    fixture(body, (topPath) => {
      assert.equal(loadConfig({ topPath, env: {} }).get('apple.developer_dir'), '');
    });
  }
});

test('Apple developer directory accepts a path and canonical environment override', () => {
  fixture('apple:\n  developer_dir: /Applications/Configured Xcode.app/Contents/Developer\n', (topPath) => {
    assert.equal(loadConfig({ topPath, env: {} }).get('apple.developer_dir'),
      '/Applications/Configured Xcode.app/Contents/Developer');
    assert.equal(loadConfig({ topPath, env: {
      AGENT_OS_APPLE_DEVELOPER_DIR: '/Applications/Override.app/Contents/Developer',
    } }).get('apple.developer_dir'), '/Applications/Override.app/Contents/Developer');
  });
});

for (const body of ['developer_dir: null', 'developer_dir: false', 'developer_dir: 42', 'developer_dir: []']) {
  test(`Apple strict schema rejects ${body}`, () => {
    fixture(`apple:\n  ${body}\n`, (topPath) => {
      assert.throws(() => loadConfig({ topPath, env: {} }), AgentOSConfigError);
    });
  });
}

test('Apple sibling-reader fields are ignored', () => {
  fixture('apple:\n  future_example: true\n', topPath => {
    assert.equal(loadConfig({ topPath, env: {} }).get('apple.future_example'), null);
  });
});
