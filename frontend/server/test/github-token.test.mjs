/**
 * The token-source tests (ARF-02 requirement 4, SPEC §6 ambient-identity RCA).
 *
 * The property under test is not "a token can be read". It is that **every** way
 * of not having a usable token is loud, and that there is no path by which ARF
 * quietly authenticates as somebody else.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { loadConfig } from '../src/config.mjs';
import { ArfGithubAuthError } from '../src/github/errors.mjs';
import { describeTokenSource, readGithubToken, tokenSource } from '../src/github/token.mjs';

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'arf-token-'));
}

function configFor(env = {}) {
  return loadConfig({ env: { ARF_STATE_ROOT: tmpDir(), ...env } });
}

describe('GitHub token source', () => {
  it('reads the token from the configured env var', async () => {
    const env = { ARF_STATE_ROOT: tmpDir(), ARF_GITHUB_TOKEN: 'ghs_realtoken' };
    const config = loadConfig({ env });
    assert.deepEqual(tokenSource(config), { kind: 'env', ref: 'ARF_GITHUB_TOKEN' });
    assert.equal(await readGithubToken(config, { env }), 'ghs_realtoken');
  });

  it('reads the token from a configured file, which wins over the env var', async () => {
    const dir = tmpDir();
    const path = join(dir, 'token');
    writeFileSync(path, 'ghs_fromfile\n');
    const env = { ARF_STATE_ROOT: dir, ARF_GITHUB_TOKEN_FILE: path, ARF_GITHUB_TOKEN: 'ghs_fromenv' };
    const config = loadConfig({ env });
    assert.equal(tokenSource(config).kind, 'file');
    // Trailing newline stripped: a heredoc-written secret file always has one.
    assert.equal(await readGithubToken(config, { env }), 'ghs_fromfile');
  });

  it('fails loud when no token is configured', async () => {
    const config = configFor();
    await assert.rejects(
      readGithubToken(config, { env: {} }),
      (err) => err instanceof ArfGithubAuthError && /not configured/.test(err.message),
    );
  });

  it('never falls back to an ambient GITHUB_TOKEN / GH_TOKEN', async () => {
    // This is the whole hard boundary in one assertion. A process started from a
    // shell that happens to export GITHUB_TOKEN must NOT silently authenticate
    // as whoever that is — that is the 2026-07-23 ambient-identity RCA, and it
    // is the reason ARF names its variable instead of scavenging for one.
    const config = configFor();
    const ambient = { GITHUB_TOKEN: 'ghp_ambient', GH_TOKEN: 'ghp_ambient', GITHUB_APP_TOKEN: 'ghs_x' };
    await assert.rejects(readGithubToken(config, { env: ambient }), ArfGithubAuthError);

    // ...unless an operator names it, which is a decision with a record.
    const named = loadConfig({ env: { ARF_STATE_ROOT: tmpDir(), ARF_GITHUB_TOKEN_ENV: 'GITHUB_TOKEN' } });
    assert.equal(await readGithubToken(named, { env: ambient }), 'ghp_ambient');
  });

  it('fails loud on an empty or whitespace-only token', async () => {
    const config = configFor();
    await assert.rejects(
      readGithubToken(config, { env: { ARF_GITHUB_TOKEN: '   ' } }),
      (err) => err instanceof ArfGithubAuthError && /empty/.test(err.message),
    );
  });

  it('names an unresolved secret reference instead of letting it 401', async () => {
    // `op://vault/item/field` passed through as a bearer token produces a bare
    // "Bad credentials", and the operator goes looking at App permissions.
    const config = configFor();
    await assert.rejects(
      readGithubToken(config, { env: { ARF_GITHUB_TOKEN: 'op://Private/gh/token' } }),
      (err) => err instanceof ArfGithubAuthError && /unresolved secret reference/.test(err.message),
    );
  });

  it('rejects a token with embedded whitespace', async () => {
    const config = configFor();
    await assert.rejects(
      readGithubToken(config, { env: { ARF_GITHUB_TOKEN: 'Bearer ghs_token' } }),
      (err) => err instanceof ArfGithubAuthError && /whitespace/.test(err.message),
    );
  });

  it('fails loud on an unreadable token file rather than falling through to env', async () => {
    const dir = tmpDir();
    const env = {
      ARF_STATE_ROOT: dir,
      ARF_GITHUB_TOKEN_FILE: join(dir, 'absent', 'token'),
      ARF_GITHUB_TOKEN: 'ghs_wouldhaveworked',
    };
    const config = loadConfig({ env });
    await assert.rejects(
      readGithubToken(config, { env }),
      (err) => err instanceof ArfGithubAuthError && /could not be read/.test(err.message),
    );
  });

  it('describes the source without ever exposing the token value', async () => {
    const env = { ARF_STATE_ROOT: tmpDir(), ARF_GITHUB_TOKEN: 'ghs_supersecret' };
    const config = loadConfig({ env });
    const described = await describeTokenSource(config, { env });
    assert.deepEqual(described, {
      kind: 'env',
      ref: 'ARF_GITHUB_TOKEN',
      present: true,
      reason: null,
    });
    assert.ok(!JSON.stringify(described).includes('ghs_supersecret'));
  });

  it('describes a missing token with the actionable reason, not a bare false', async () => {
    const described = await describeTokenSource(configFor(), { env: {} });
    assert.equal(described.present, false);
    assert.match(described.reason, /ARF_GITHUB_TOKEN/);
    assert.match(described.reason, /ambient/);
  });

  it('keeps the token out of the resolved config object entirely', () => {
    const env = { ARF_STATE_ROOT: tmpDir(), ARF_GITHUB_TOKEN: 'ghs_supersecret' };
    const config = loadConfig({ env });
    assert.ok(!JSON.stringify(config).includes('ghs_supersecret'));
    assert.equal(config.github.tokenEnv, 'ARF_GITHUB_TOKEN');
  });
});
