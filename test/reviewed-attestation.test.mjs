import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';

import {
  buildReviewedAttestationPayload,
  emitReviewedAttestation,
  recordSignedReviewedAttestation,
  signReviewedAttestation,
} from '../src/reviewed-attestation.mjs';

const execFileAsync = promisify(execFile);
const TEST_DIGEST = `sha256:${'A'.repeat(43)}`;
const REAL_ENVELOPE_FIXTURE_URL = new URL(
  './fixtures/reviewed-attestation/hq-attest-sign-real-envelope.json',
  import.meta.url
);

function signatureFor(subject) {
  return {
    algorithm: 'hcp-hmac-sha256:v1',
    subject,
    digest: TEST_DIGEST,
  };
}

function execFileResultWithStdin({ stdout = '', error = null, onInput = () => {} } = {}) {
  let settle;
  const execution = new Promise((resolve, reject) => {
    settle = () => (error ? reject(error) : resolve({ stdout, stderr: '' }));
  });
  execution.child = {
    stdin: {
      end(input) {
        onInput(input);
        settle();
      },
    },
  };
  return execution;
}

function loadRealEnvelopeFixture() {
  return JSON.parse(readFileSync(REAL_ENVELOPE_FIXTURE_URL, 'utf8'));
}

test('reviewed attestation payload binds reviewer identity, reviewed head, verdict, and findings count', () => {
  const payload = buildReviewedAttestationPayload({
    repo: 'laceyenterprises/agent-os',
    prNumber: 3491,
    headSha: 'abc123',
    reviewerIdentity: 'gemini-reviewer-lacey',
    verdict: 'comment-only',
    findingsCount: 0,
    ts: '2026-07-12T00:00:00.000Z',
  });

  assert.deepEqual(payload, {
    schema_version: 1,
    repo: 'laceyenterprises/agent-os',
    pr_number: 3491,
    head_sha: 'abc123',
    parent_head_sha: null,
    kind: 'reviewed',
    producer_identity: 'gemini-reviewer-lacey',
    verdict: 'comment-only',
    findings_count: 0,
    payload: { reviewer_identity: 'gemini-reviewer-lacey' },
    ts: '2026-07-12T00:00:00.000Z',
  });
});

test('reviewed attestation accepts the real hq attest sign envelope contract', async () => {
  const signedFixture = loadRealEnvelopeFixture();
  const { signature, ...payload } = signedFixture;

  assert.deepEqual(Object.keys(signature).sort(), ['algorithm', 'digest', 'subject']);
  assert.equal(Object.prototype.hasOwnProperty.call(signature, 'verified'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(signedFixture, 'hcp_subject'), false);

  const signed = await signReviewedAttestation({
    payload,
    execFileImpl: async () => ({ stdout: readFileSync(REAL_ENVELOPE_FIXTURE_URL, 'utf8') }),
  });

  assert.deepEqual(signed, signedFixture);
});

test('reviewed attestation accepts an equivalent nested payload with reordered keys', async () => {
  const payload = buildReviewedAttestationPayload({
    repo: 'laceyenterprises/agent-os',
    prNumber: 3491,
    headSha: 'abc123',
    reviewerIdentity: 'gemini-reviewer-lacey',
    verdict: 'comment-only',
    findingsCount: 0,
    ts: '2026-07-12T00:00:00.000Z',
  });
  payload.payload.review_model = 'gemini';

  const signed = await signReviewedAttestation({
    payload,
    execFileImpl: async () => ({
      stdout: JSON.stringify({
        ...payload,
        payload: {
          review_model: 'gemini',
          reviewer_identity: 'gemini-reviewer-lacey',
        },
        signature: signatureFor('gemini-reviewer-lacey'),
      }),
    }),
  });

  assert.deepEqual(signed.payload, payload.payload);
});

test('reviewed attestation signing uses the shipped flag contract and records the signed result', async () => {
  const calls = [];
  const result = await emitReviewedAttestation({
    repo: 'laceyenterprises/agent-os',
    prNumber: 3491,
    headSha: 'def456',
    reviewerIdentity: 'claude-reviewer-lacey',
    verdict: 'request-changes',
    reviewBody: [
      '## Blocking issues',
      '- **Regression**',
      '',
      '## Verdict',
      'Request changes',
    ].join('\n'),
    hqPath: '/tmp/hq',
    env: { PATH: '/usr/bin', KEEP_ME: 'yes', HCP_SUBJECT: 'stale-global-subject' },
    execFileImpl: (cmd, args, options) => {
      calls.push({ cmd, args, options });
      if (args[1] === 'record') {
        return execFileResultWithStdin({
          stdout: JSON.stringify({ recorded: true }),
          onInput: (input) => { calls.at(-1).input = input; },
        });
      }
      return Promise.resolve({
        stdout: JSON.stringify({
          schema_version: 1,
          repo: 'laceyenterprises/agent-os',
          pr_number: 3491,
          head_sha: 'def456',
          parent_head_sha: null,
          kind: 'reviewed',
          producer_identity: 'claude-reviewer-lacey',
          verdict: 'request-changes',
          findings_count: 1,
          payload: { reviewer_identity: 'claude-reviewer-lacey' },
          ts: resultTimestamp(args),
          signature: signatureFor('claude-reviewer-lacey'),
        }),
      });
    },
    log: { log() {} },
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].cmd, '/tmp/hq');
  assert.deepEqual(calls[0].args.slice(0, 10), [
    'attest', 'sign', '--repo', 'laceyenterprises/agent-os', '--pr', '3491',
    '--head-sha', 'def456', '--kind', 'reviewed',
  ]);
  assert.equal(calls[0].options.input, undefined);
  assert.deepEqual(calls[0].options.env, {
    PATH: '/usr/bin',
    KEEP_ME: 'yes',
    HCP_SUBJECT: 'claude-reviewer-lacey',
  });
  assert.deepEqual(calls[1].args, ['attest', 'record', '--payload', '-']);
  assert.equal(calls[1].options.input, undefined);
  assert.deepEqual(calls[1].options.env, {
    PATH: '/usr/bin',
    KEEP_ME: 'yes',
    HCP_SUBJECT: 'stale-global-subject',
  });
  const signedInput = JSON.parse(calls[1].input);
  assert.equal(signedInput.kind, 'reviewed');
  assert.equal(signedInput.head_sha, 'def456');
  assert.equal(result.signed.signature.subject, 'claude-reviewer-lacey');
  assert.deepEqual(result.recorded, { recorded: true });
});

function resultTimestamp(args) {
  return args[args.indexOf('--ts') + 1];
}

test('reviewed attestation signing rejects an explicit non-reviewer signer subject', async () => {
  await assert.rejects(
    emitReviewedAttestation({
      repo: 'laceyenterprises/agent-os',
      prNumber: 3491,
      headSha: 'def456',
      reviewerIdentity: 'claude-reviewer-lacey',
      verdict: 'comment-only',
      reviewBody: '## Blocking issues\n- None.\n\n## Verdict\nComment only',
      execFileImpl: async (_cmd, args) => {
        const payload = buildReviewedAttestationPayload({
          repo: 'laceyenterprises/agent-os',
          prNumber: 3491,
          headSha: 'def456',
          reviewerIdentity: 'claude-reviewer-lacey',
          verdict: 'comment-only',
          findingsCount: 0,
          ts: resultTimestamp(args),
        });
        return {
          stdout: JSON.stringify({
            ...payload,
            signature: signatureFor('codex-reviewer-lacey'),
          }),
        };
      },
      log: { log() {} },
    }),
    /HCP subject mismatch/
  );
});

test('reviewed attestation signing retries transient subprocess failures with bounded backoff', async () => {
  const delays = [];
  let attempts = 0;
  const payload = buildReviewedAttestationPayload({
    repo: 'laceyenterprises/agent-os',
    prNumber: 3491,
    headSha: 'def456',
    reviewerIdentity: 'codex-reviewer-lacey',
    verdict: 'comment-only',
  });

  const signed = await signReviewedAttestation({
    payload,
    retryDelayMs: 10,
    delayImpl: async (ms) => delays.push(ms),
    execFileImpl: async () => {
      attempts += 1;
      if (attempts < 3) throw Object.assign(new Error('resource temporarily unavailable'), { code: 'EAGAIN' });
      return { stdout: JSON.stringify({
        ...payload,
        signature: signatureFor(payload.payload.reviewer_identity),
      }) };
    },
  });

  assert.equal(attempts, 3);
  assert.deepEqual(delays, [10, 20]);
  assert.equal(signed.head_sha, payload.head_sha);
});

test('reviewed attestation signing retries subprocesses killed by execFile timeout', async () => {
  const delays = [];
  let attempts = 0;
  const payload = buildReviewedAttestationPayload({
    repo: 'laceyenterprises/agent-os',
    prNumber: 3491,
    headSha: 'def456',
    reviewerIdentity: 'codex-reviewer-lacey',
    verdict: 'comment-only',
  });

  const signed = await signReviewedAttestation({
    payload,
    retryDelayMs: 10,
    delayImpl: async (ms) => delays.push(ms),
    execFileImpl: async () => {
      attempts += 1;
      if (attempts < 3) {
        throw Object.assign(new Error('Command failed: hq attest sign'), {
          killed: true,
          signal: 'SIGTERM',
        });
      }
      return { stdout: JSON.stringify({
        ...payload,
        signature: signatureFor(payload.payload.reviewer_identity),
      }) };
    },
  });

  assert.equal(attempts, 3);
  assert.deepEqual(delays, [10, 20]);
  assert.equal(signed.head_sha, payload.head_sha);
});

test('reviewed attestation signing rejects unsigned and incomplete signer output', async () => {
  const payload = buildReviewedAttestationPayload({
    repo: 'laceyenterprises/agent-os',
    prNumber: 3491,
    headSha: 'def456',
    reviewerIdentity: 'codex-reviewer-lacey',
    verdict: 'comment-only',
  });
  await assert.rejects(
    signReviewedAttestation({
      payload,
      execFileImpl: async () => ({ stdout: JSON.stringify(payload) }),
    }),
    /signature is missing/
  );
  const { kind: _kind, ...withoutKind } = payload;
  await assert.rejects(
    signReviewedAttestation({
      payload,
      execFileImpl: async () => ({
        stdout: JSON.stringify({ ...withoutKind, signature: signatureFor('codex-reviewer-lacey') }),
      }),
    }),
    /payload keys mismatch/
  );
});

test('reviewed attestation signing rejects malformed signature envelopes', async () => {
  const payload = buildReviewedAttestationPayload({
    repo: 'laceyenterprises/agent-os',
    prNumber: 3491,
    headSha: 'def456',
    reviewerIdentity: 'codex-reviewer-lacey',
    verdict: 'comment-only',
  });

  await assert.rejects(
    signReviewedAttestation({
      payload,
      execFileImpl: async () => ({
        stdout: JSON.stringify({
          ...payload,
          signature: {
            algorithm: 'hcp-hmac-sha256:v1',
            subject: payload.payload.reviewer_identity,
            digest: 'not-a-sha256-digest',
          },
        }),
      }),
    }),
    /signature digest is malformed/
  );

  await assert.rejects(
    signReviewedAttestation({
      payload,
      execFileImpl: async () => ({
        stdout: JSON.stringify({
          ...payload,
          signature: {
            algorithm: 'fictional-local-signer',
            subject: payload.payload.reviewer_identity,
            digest: TEST_DIGEST,
          },
        }),
      }),
    }),
    /signature algorithm mismatch/
  );
});

test('reviewed attestation signing rejects payload mismatches and extra signed fields', async () => {
  const payload = buildReviewedAttestationPayload({
    repo: 'laceyenterprises/agent-os',
    prNumber: 3491,
    headSha: 'def456',
    reviewerIdentity: 'codex-reviewer-lacey',
    verdict: 'comment-only',
  });

  await assert.rejects(
    signReviewedAttestation({
      payload,
      execFileImpl: async () => ({
        stdout: JSON.stringify({
          ...payload,
          head_sha: 'mutated-head',
          signature: signatureFor(payload.payload.reviewer_identity),
        }),
      }),
    }),
    /head_sha mismatch/
  );

  await assert.rejects(
    signReviewedAttestation({
      payload,
      execFileImpl: async () => ({
        stdout: JSON.stringify({
          ...payload,
          hcp_subject: payload.payload.reviewer_identity,
          signature: signatureFor(payload.payload.reviewer_identity),
        }),
      }),
    }),
    /payload keys mismatch/
  );
});

test('reviewed attestation signing does not retry permanent subprocess failures', async () => {
  let attempts = 0;
  await assert.rejects(
    signReviewedAttestation({
      payload: {
        kind: 'reviewed',
        payload: { reviewer_identity: 'codex-reviewer-lacey' },
      },
      execFileImpl: async () => {
        attempts += 1;
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      },
    }),
    /permission denied/
  );
  assert.equal(attempts, 1);
});

test('reviewed attestation recording retries transient subprocess failures with bounded backoff', async () => {
  const delays = [];
  let attempts = 0;
  const recorded = await recordSignedReviewedAttestation({
    signed: { kind: 'reviewed', signature: signatureFor('codex-reviewer-lacey') },
    retryDelayMs: 10,
    delayImpl: async (ms) => delays.push(ms),
    execFileImpl: () => {
      attempts += 1;
      return execFileResultWithStdin({
        error: attempts < 3 ? Object.assign(new Error('I/O unavailable'), { code: 'EIO' }) : null,
        stdout: JSON.stringify({ recorded: true }),
      });
    },
  });

  assert.equal(attempts, 3);
  assert.deepEqual(delays, [10, 20]);
  assert.deepEqual(recorded, { recorded: true });
});

test('reviewed attestation emit fails closed when hq attest record rejects the signed envelope', async () => {
  const calls = [];
  await assert.rejects(
    emitReviewedAttestation({
      repo: 'laceyenterprises/agent-os',
      prNumber: 3491,
      headSha: 'def456',
      reviewerIdentity: 'claude-reviewer-lacey',
      verdict: 'comment-only',
      reviewBody: '## Blocking issues\n- None.\n\n## Verdict\nComment only',
      execFileImpl: (_cmd, args) => {
        calls.push(args);
        if (args[1] === 'record') {
          return execFileResultWithStdin({
            error: Object.assign(new Error('attestation verification failed'), { code: 'EACCES' }),
          });
        }
        const payload = buildReviewedAttestationPayload({
          repo: 'laceyenterprises/agent-os',
          prNumber: 3491,
          headSha: 'def456',
          reviewerIdentity: 'claude-reviewer-lacey',
          verdict: 'comment-only',
          findingsCount: 0,
          ts: resultTimestamp(args),
        });
        return Promise.resolve({
          stdout: JSON.stringify({
            ...payload,
            signature: signatureFor(payload.payload.reviewer_identity),
          }),
        });
      },
      log: { log() {} },
    }),
    /attestation verification failed/
  );
  assert.equal(calls.length, 2);
});

test('reviewed attestation recording does not retry permanent subprocess failures', async () => {
  let attempts = 0;
  await assert.rejects(
    recordSignedReviewedAttestation({
      signed: { kind: 'reviewed' },
      execFileImpl: () => {
        attempts += 1;
        return execFileResultWithStdin({
          error: Object.assign(new Error('permission denied'), { code: 'EACCES' }),
        });
      },
    }),
    /permission denied/
  );
  assert.equal(attempts, 1);
});

test('reviewed attestation recording writes payload to a real child stdin stream', async () => {
  const signed = { kind: 'reviewed', signature: signatureFor('codex-reviewer-lacey') };
  const recorded = await recordSignedReviewedAttestation({
    signed,
    hqPath: process.execPath,
    execFileImpl: (_command, _args, options) => execFileAsync(process.execPath, [
      '-e',
      `let input = ''; process.stdin.setEncoding('utf8'); `
        + `process.stdin.on('data', (chunk) => { input += chunk; }); `
        + `process.stdin.on('end', () => process.stdout.write(JSON.stringify({ received: JSON.parse(input) })));`,
    ], options),
  });

  assert.deepEqual(recorded.received, signed);
});

test('reviewed attestation signing rejects non-JSON signer output', async () => {
  await assert.rejects(
    signReviewedAttestation({
      payload: {
        kind: 'reviewed',
        payload: { reviewer_identity: 'codex-reviewer-lacey' },
      },
      execFileImpl: async () => ({ stdout: 'not-json' }),
    }),
    /returned invalid JSON/
  );
});

test('reviewed attestation code does not define a Node-local signing canonicalizer', () => {
  const source = readFileSync(new URL('../src/reviewed-attestation.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /canonical/i);
});
