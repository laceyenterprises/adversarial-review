import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  buildReviewedAttestationPayload,
  emitReviewedAttestation,
  signReviewedAttestation,
} from '../src/reviewed-attestation.mjs';

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
    reviewer_identity: 'gemini-reviewer-lacey',
    verdict: 'comment-only',
    findings_count: 0,
    ts: '2026-07-12T00:00:00.000Z',
  });
});

test('reviewed attestation signing shells out to hq attest sign with JSON on stdin', async () => {
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
    execFileImpl: async (cmd, args, options) => {
      calls.push({ cmd, args, options });
      const payload = JSON.parse(options.input);
      return {
        stdout: JSON.stringify({
          ...payload,
          signature: {
            verified: true,
            hcp_subject: payload.reviewer_identity,
          },
        }),
      };
    },
    log: { log() {} },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, '/tmp/hq');
  assert.deepEqual(calls[0].args, ['attest', 'sign', '--payload', '-']);
  const signedInput = JSON.parse(calls[0].options.input);
  assert.equal(signedInput.kind, 'reviewed');
  assert.equal(signedInput.head_sha, 'def456');
  assert.equal(signedInput.verdict, 'request-changes');
  assert.equal(signedInput.findings_count, 1);
  assert.equal(result.signed.signature.hcp_subject, 'claude-reviewer-lacey');
});

test('reviewed attestation signing rejects an explicit non-reviewer HCP subject', async () => {
  await assert.rejects(
    emitReviewedAttestation({
      repo: 'laceyenterprises/agent-os',
      prNumber: 3491,
      headSha: 'def456',
      reviewerIdentity: 'claude-reviewer-lacey',
      verdict: 'comment-only',
      reviewBody: '## Blocking issues\n- None.\n\n## Verdict\nComment only',
      execFileImpl: async (_cmd, _args, options) => {
        const payload = JSON.parse(options.input);
        return {
          stdout: JSON.stringify({
            ...payload,
            signature: {
              verified: true,
              hcp_subject: 'codex-reviewer-lacey',
            },
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
      return { stdout: JSON.stringify(payload) };
    },
  });

  assert.equal(attempts, 3);
  assert.deepEqual(delays, [10, 20]);
  assert.equal(signed.head_sha, payload.head_sha);
});

test('reviewed attestation signing does not retry permanent subprocess failures', async () => {
  let attempts = 0;
  await assert.rejects(
    signReviewedAttestation({
      payload: { kind: 'reviewed' },
      execFileImpl: async () => {
        attempts += 1;
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      },
    }),
    /permission denied/
  );
  assert.equal(attempts, 1);
});

test('reviewed attestation signing rejects non-JSON signer output', async () => {
  await assert.rejects(
    signReviewedAttestation({
      payload: { kind: 'reviewed' },
      execFileImpl: async () => ({ stdout: 'not-json' }),
    }),
    /returned invalid JSON: .*stdout="not-json"/
  );
});

test('reviewed attestation code does not define a Node-local signing canonicalizer', () => {
  const source = readFileSync(new URL('../src/reviewed-attestation.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /canonical/i);
});
