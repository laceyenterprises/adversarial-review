import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveGeminiCredentialConcurrencyForDispatchCandidates,
  readReviewerBrokerSharedSecretBestEffort,
} from '../src/watcher.mjs';

test('gemini credential count fetch is skipped when dispatch has no gemini candidates', async () => {
  let fetches = 0;
  let secretReads = 0;
  const concurrency = await resolveGeminiCredentialConcurrencyForDispatchCandidates([
    { reviewerModel: 'codex' },
    { reviewerModel: 'claude' },
    {},
  ], {
    env: {
      CQP_BROKER_URL: 'http://broker.local',
      CQP_BROKER_SHARED_SECRET_FILE: '/tmp/secret',
    },
    fetchCredentialConcurrency: async () => {
      fetches += 1;
      return 2;
    },
    readSharedSecret: async () => {
      secretReads += 1;
      return 'secret';
    },
  });

  assert.equal(concurrency, null);
  assert.equal(fetches, 0);
  assert.equal(secretReads, 0);
});

test('gemini credential count fetch reads the secret only for gemini candidates with a broker url', async () => {
  let secretReads = 0;
  const concurrency = await resolveGeminiCredentialConcurrencyForDispatchCandidates([
    { reviewerModel: 'gemini' },
  ], {
    env: {
      OAUTH_BROKER_URL: 'http://broker.local',
      OAUTH_BROKER_SHARED_SECRET_FILE: '/tmp/secret',
    },
    fetchCredentialConcurrency: async ({ brokerUrl, secret }) => {
      assert.equal(brokerUrl, 'http://broker.local');
      assert.equal(secret, 'secret');
      return 3;
    },
    readSharedSecret: async () => {
      secretReads += 1;
      return 'secret';
    },
  });

  assert.equal(concurrency, 3);
  assert.equal(secretReads, 1);
});

test('reviewer broker shared secret reads asynchronously and uses TTL cache', async () => {
  let reads = 0;
  const fsImpl = {
    async readFile(file, encoding) {
      reads += 1;
      assert.equal(file, '/tmp/adversarial-review-secret-cache-test');
      assert.equal(encoding, 'utf8');
      return ` secret-${reads} \n`;
    },
  };
  const env = { CQP_BROKER_SHARED_SECRET_FILE: '/tmp/adversarial-review-secret-cache-test' };
  const logger = { warn() {} };

  assert.equal(
    await readReviewerBrokerSharedSecretBestEffort(env, { fsImpl, now: () => 1000, ttlMs: 5000, logger }),
    'secret-1'
  );
  assert.equal(
    await readReviewerBrokerSharedSecretBestEffort(env, { fsImpl, now: () => 2000, ttlMs: 5000, logger }),
    'secret-1'
  );
  assert.equal(reads, 1);

  assert.equal(
    await readReviewerBrokerSharedSecretBestEffort(env, { fsImpl, now: () => 7000, ttlMs: 5000, logger }),
    'secret-2'
  );
  assert.equal(reads, 2);
});

test('reviewer broker shared secret warns for non-missing read failures', async () => {
  const warnings = [];
  const fsImpl = {
    async readFile() {
      const err = new Error('permission denied');
      err.code = 'EACCES';
      throw err;
    },
  };

  assert.equal(
    await readReviewerBrokerSharedSecretBestEffort(
      { CQP_BROKER_SHARED_SECRET_FILE: '/tmp/adversarial-review-secret-eacces-test' },
      {
        fsImpl,
        now: () => 10_000,
        ttlMs: 5000,
        logger: { warn(message) { warnings.push(message); } },
      }
    ),
    ''
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /EACCES/);
});
