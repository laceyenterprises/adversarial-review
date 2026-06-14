import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  materializePerWorkerCodexAuth,
  PER_WORKER_PLACEHOLDER_REFRESH_TOKEN,
} from '../src/codex-per-worker-auth.mjs';

function writeSharedAuth(dir, tokens = { access_token: 'fresh-access', refresh_token: 'real-refresh', id_token: 'id', expires_at: 123 }) {
  const codexHome = path.join(dir, '.codex');
  mkdirSync(codexHome, { recursive: true });
  const authPath = path.join(codexHome, 'auth.json');
  writeFileSync(authPath, JSON.stringify({ auth_mode: 'chatgpt', tokens }), 'utf8');
  return authPath;
}

test('materializePerWorkerCodexAuth replaces refresh_token with placeholder and preserves access_token', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pw-auth-'));
  try {
    const sharedAuthPath = writeSharedAuth(root);
    const result = materializePerWorkerCodexAuth({
      sharedAuthPath,
      key: 'job-123',
      env: {},
      brokerRefresh: false,
    });
    assert.ok(result, 'expected materialization to succeed');
    assert.ok(existsSync(result.authPath));
    // Materialized under the operator home, not the shared codex home.
    assert.equal(result.home, root);
    assert.equal(result.codexHome, path.dirname(result.authPath));
    assert.ok(result.authPath.includes(path.join('.codex', '.per-worker', 'job-123')));

    const written = JSON.parse(readFileSync(result.authPath, 'utf8'));
    assert.equal(written.tokens.refresh_token, PER_WORKER_PLACEHOLDER_REFRESH_TOKEN);
    assert.equal(written.tokens.access_token, 'fresh-access');
    assert.equal(written.auth_mode, 'chatgpt');
    // 0600 perms on the credential file.
    assert.equal(statSync(result.authPath).mode & 0o777, 0o600);

    result.cleanup();
    assert.equal(existsSync(result.codexHome), false, 'cleanup should remove the per-worker dir');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('materializePerWorkerCodexAuth returns null when kill-switch is set', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pw-auth-'));
  try {
    const sharedAuthPath = writeSharedAuth(root);
    const result = materializePerWorkerCodexAuth({
      sharedAuthPath,
      key: 'job-123',
      env: { AGENT_OS_CODEX_PER_WORKER_AUTH: '0' },
      brokerRefresh: false,
    });
    assert.equal(result, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('materializePerWorkerCodexAuth is fail-safe on a missing source', () => {
  const result = materializePerWorkerCodexAuth({
    sharedAuthPath: '/nonexistent/.codex/auth.json',
    key: 'job-123',
    env: {},
    brokerRefresh: false,
  });
  assert.equal(result, null);
});

test('materializePerWorkerCodexAuth is fail-safe on a non-chatgpt auth file', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pw-auth-'));
  try {
    const codexHome = path.join(root, '.codex');
    mkdirSync(codexHome, { recursive: true });
    const authPath = path.join(codexHome, 'auth.json');
    writeFileSync(authPath, JSON.stringify({ auth_mode: 'apikey', tokens: { access_token: 'x' } }), 'utf8');
    const result = materializePerWorkerCodexAuth({ sharedAuthPath: authPath, key: 'j', env: {}, brokerRefresh: false });
    assert.equal(result, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('materializePerWorkerCodexAuth sweeps stale per-worker dirs', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pw-auth-'));
  try {
    const sharedAuthPath = writeSharedAuth(root);
    const baseDir = path.join(root, '.codex', '.per-worker');
    mkdirSync(path.join(baseDir, 'stale-old'), { recursive: true });
    writeFileSync(path.join(baseDir, 'stale-old', 'auth.json'), '{}', 'utf8');

    // now far in the future so the existing dir is past the 6h cutoff.
    const future = Date.now() + 7 * 60 * 60 * 1000;
    const result = materializePerWorkerCodexAuth({
      sharedAuthPath,
      key: 'fresh-job',
      env: {},
      brokerRefresh: false,
      now: future,
    });
    assert.ok(result);
    assert.equal(existsSync(path.join(baseDir, 'stale-old')), false, 'stale dir should be swept');
    assert.ok(existsSync(result.authPath));
    result.cleanup();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
