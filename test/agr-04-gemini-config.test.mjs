import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  routeSubject,
} from '../src/adapters/subject/github-pr/routing.mjs';
import {
  resolveGeminiReviewerMode,
  resolveGeminiRuntime,
} from '../src/role-config.mjs';
import { resolveAgyPrintTimeoutMs } from '../src/reviewer-timeout.mjs';

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

test('AGR-CONVERGE-01 antigravity print timeout resolves from CFG and env aliases', () => {
  const tmp = makeTmp();
  try {
    const modulePath = join(tmp, 'config.yaml');
    writeYaml(modulePath, `
reviewer:
  gemini:
    antigravity:
      print_timeout_ms: 1500000
`);
    const options = { env: {}, topPath: '/dev/null', modulePaths: [modulePath] };
    assert.equal(resolveAgyPrintTimeoutMs(options.env, options), 1_500_000);
    assert.equal(
      resolveAgyPrintTimeoutMs(
        { ADVERSARIAL_REVIEW_GEMINI_ANTIGRAVITY_PRINT_TIMEOUT_MS: '1600000' },
        options,
      ),
      1_600_000,
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
`);
    writeYaml(moduleLocalPath, `
reviewer:
  gemini:
    runtime: antigravity
`);

    assert.equal(
      resolveGeminiRuntime({ env: {}, topPath: '/dev/null', modulePaths: [modulePath] }),
      'antigravity',
    );

    const env = {
      AGENT_OS_REVIEWER_GEMINI_RUNTIME: 'cli',
    };
    assert.equal(
      resolveGeminiRuntime({ env, topPath: '/dev/null', modulePaths: [modulePath] }),
      'cli',
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
