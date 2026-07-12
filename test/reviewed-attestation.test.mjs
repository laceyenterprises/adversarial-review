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
    verdict: 'comment-only',
    findings_count: 0,
    payload: { reviewer_identity: 'gemini-reviewer-lacey' },
    ts: '2026-07-12T00:00:00.000Z',
  });
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
    execFileImpl: async (cmd, args, options) => {
      calls.push({ cmd, args, options });
      if (args[1] === 'record') {
        return { stdout: JSON.stringify({ recorded: true }) };
      }
      return {
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
          signature: {
            verified: true,
            hcp_subject: 'claude-reviewer-lacey',
          },
        }),
      };
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
  assert.deepEqual(calls[1].args, ['attest', 'record', '--payload', '-']);
  const signedInput = JSON.parse(calls[1].options.input);
  assert.equal(signedInput.kind, 'reviewed');
  assert.equal(signedInput.head_sha, 'def456');
  assert.equal(result.signed.signature.hcp_subject, 'claude-reviewer-lacey');
  assert.deepEqual(result.recorded, { recorded: true });
});

function resultTimestamp(args) {
  return args[args.indexOf('--ts') + 1];
}

test('reviewed attestation signing rejects an explicit non-reviewer HCP subject', async () => {
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
      return { stdout: JSON.stringify({
        ...payload,
        signature: { verified: true, hcp_subject: payload.payload.reviewer_identity },
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
    /signature missing or did not verify/
  );
  const { kind: _kind, ...withoutKind } = payload;
  await assert.rejects(
    signReviewedAttestation({
      payload,
      execFileImpl: async () => ({
        stdout: JSON.stringify({ ...withoutKind, signature: { verified: true } }),
      }),
    }),
    /kind mismatch/
  );
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
    /returned invalid JSON/
  );
});

test('reviewed attestation code does not define a Node-local signing canonicalizer', () => {
  const source = readFileSync(new URL('../src/reviewed-attestation.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /canonical/i);
});
