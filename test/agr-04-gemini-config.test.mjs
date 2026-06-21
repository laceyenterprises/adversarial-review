import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  routeSubject,
  validateDefaultReviewerRouteConfig,
} from '../src/adapters/subject/github-pr/routing.mjs';
import {
  resolveAntigravityAccounts,
  resolveGeminiReviewerMode,
  resolveGeminiRuntime,
} from '../src/role-config.mjs';

function makeTmp() {
  return mkdtempSync(join(tmpdir(), 'agr-04-gemini-config-'));
}

function writeYaml(path, body) {
  writeFileSync(path, body, 'utf8');
}

test('AGR-04 runtime defaults to cli and rejects unknown runtime values', () => {
  const tmp = makeTmp();
  try {
    assert.equal(
      resolveGeminiRuntime({ env: {}, topPath: '/dev/null', modulePaths: [join(tmp, 'none.yaml')] }),
      'cli',
    );

    const modulePath = join(tmp, 'config.yaml');
    writeYaml(modulePath, 'reviewer:\n  gemini:\n    runtime: native\n');
    assert.throws(
      () => resolveGeminiRuntime({ env: {}, topPath: '/dev/null', modulePaths: [modulePath] }),
      /reviewer\.gemini\.runtime.*cli.*antigravity/i,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('AGR-06 gemini reviewer mode tracked default remains off', () => {
  const tmp = makeTmp();
  try {
    assert.equal(
      resolveGeminiReviewerMode({ env: {}, topPath: '/dev/null', modulePaths: [join(tmp, 'none.yaml')] }),
      'off',
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('AGR-06 mode wiring can select gemini while runtime resolves to antigravity', () => {
  const tmp = makeTmp();
  try {
    const modulePath = join(tmp, 'config.yaml');
    writeYaml(modulePath, `
reviewer:
  gemini:
    mode: always-on
    runtime: antigravity
    antigravity:
      accounts:
        - id: primary
          tokenFile: op://Cliovault/GEMINI_PRIMARY/token
`);
    const options = { env: {}, topPath: '/dev/null', modulePaths: [modulePath] };
    const route = routeSubject({ builderClass: 'codex' }, options);

    assert.equal(resolveGeminiReviewerMode(options), 'always-on');
    assert.equal(resolveGeminiRuntime(options), 'antigravity');
    assert.equal(route.reviewerModel, 'gemini');
    assert.equal(route.botTokenEnv, 'GH_GEMINI_REVIEWER_TOKEN');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('AGR-04 antigravity runtime with empty accounts boots under agy runtime', () => {
  const tmp = makeTmp();
  try {
    const modulePath = join(tmp, 'config.yaml');
    writeYaml(modulePath, 'reviewer:\n  gemini:\n    runtime: antigravity\n    antigravity:\n      accounts: []\n');
    assert.doesNotThrow(
      () => validateDefaultReviewerRouteConfig({}, { topPath: '/dev/null', modulePaths: [modulePath] }),
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('AGR-04 parses ordered Antigravity account list including op refs', () => {
  const tmp = makeTmp();
  try {
    const modulePath = join(tmp, 'config.yaml');
    writeYaml(modulePath, `
reviewer:
  gemini:
    antigravity:
      accounts:
        - id: primary
          tokenFile: op://Cliovault/GEMINI_ANTIGRAVITY_PRIMARY/token
        - id: backup
          tokenFile: /Users/airlock/.config/gemini/backup-oauth.json
`);
    assert.deepEqual(
      resolveAntigravityAccounts({ env: {}, topPath: '/dev/null', modulePaths: [modulePath] }),
      [
        { id: 'primary', tokenFile: 'op://Cliovault/GEMINI_ANTIGRAVITY_PRIMARY/token' },
        { id: 'backup', tokenFile: '/Users/airlock/.config/gemini/backup-oauth.json' },
      ],
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('AGR-04 cascade precedence is module config < local yaml < env', () => {
  const tmp = makeTmp();
  try {
    const modulePath = join(tmp, 'config.yaml');
    const moduleLocalPath = join(tmp, 'config.local.yaml');
    writeYaml(modulePath, `
reviewer:
  gemini:
    runtime: cli
    antigravity:
      accounts:
        - id: module
          tokenFile: /tmp/module-token.json
`);
    writeYaml(moduleLocalPath, `
reviewer:
  gemini:
    runtime: antigravity
    antigravity:
      accounts:
        - id: local
          tokenFile: op://Cliovault/LOCAL/token
`);

    assert.equal(
      resolveGeminiRuntime({ env: {}, topPath: '/dev/null', modulePaths: [modulePath] }),
      'antigravity',
    );
    assert.deepEqual(
      resolveAntigravityAccounts({ env: {}, topPath: '/dev/null', modulePaths: [modulePath] }),
      [{ id: 'local', tokenFile: 'op://Cliovault/LOCAL/token' }],
    );

    const env = {
      AGENT_OS_REVIEWER_GEMINI_RUNTIME: 'cli',
      AGENT_OS_REVIEWER_GEMINI_ANTIGRAVITY_ACCOUNTS: JSON.stringify([
        { id: 'env', tokenFile: 'op://Cliovault/ENV/token' },
      ]),
    };
    assert.equal(
      resolveGeminiRuntime({ env, topPath: '/dev/null', modulePaths: [modulePath] }),
      'cli',
    );
    assert.deepEqual(
      resolveAntigravityAccounts({ env, topPath: '/dev/null', modulePaths: [modulePath] }),
      [{ id: 'env', tokenFile: 'op://Cliovault/ENV/token' }],
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('AGR-04 local account entries tolerate unknown rollout keys', () => {
  const tmp = makeTmp();
  try {
    const modulePath = join(tmp, 'config.yaml');
    const moduleLocalPath = join(tmp, 'config.local.yaml');
    writeYaml(modulePath, `
reviewer:
  gemini:
    antigravity:
      accounts:
        - id: module
          tokenFile: /tmp/module-token.json
`);
    writeYaml(moduleLocalPath, `
reviewer:
  gemini:
    antigravity:
      accounts:
        - id: local
          tokenFile: op://Cliovault/LOCAL/token
          priority: 10
`);

    assert.deepEqual(
      resolveAntigravityAccounts({ env: {}, topPath: '/dev/null', modulePaths: [modulePath] }),
      [{ id: 'local', tokenFile: 'op://Cliovault/LOCAL/token' }],
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('AGR-04 account env JSON parse errors redact raw value', () => {
  assert.throws(
    () => resolveAntigravityAccounts({
      env: {
        AGENT_OS_REVIEWER_GEMINI_ANTIGRAVITY_ACCOUNTS: '[{"id":"primary","tokenFile":"inline-secret-token"}',
      },
      topPath: '/dev/null',
      modulePaths: ['/dev/null'],
    }),
    (err) => {
      assert.match(err.message, /env value must be a JSON array/);
      assert.match(err.got, /^<redacted:\d+ chars>$/);
      assert.doesNotMatch(err.message, /inline-secret-token/);
      assert.doesNotMatch(String(err.got), /inline-secret-token/);
      return true;
    },
  );
});
