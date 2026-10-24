import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { createWatcherReviewerQuotaPollFactory } from '../src/watcher-reviewer-quota.mjs';
import { recordSignedReviewedAttestation } from '../src/reviewed-attestation.mjs';
import { attestationRecordErrorDetails } from '../src/attestation-record-error.mjs';

const execFileAsync = promisify(execFile);
const signed = { kind: 'docs-fast-path', repo: 'example/manual', pr_number: 1,
  head_sha: 'a'.repeat(40), payload: { policy: 'DOCSFASTPATH-01' } };

for (const fail of [false, true]) test(`watcher executor delivers record stdin and observes child exit (fail=${fail})`, async () => {
  const handlers = ['unhandledRejection', 'uncaughtException'].map(event => process.listeners(event));
  const poll = createWatcherReviewerQuotaPollFactory({ env: {} })((_command, _args, options) =>
    execFileAsync(process.execPath, ['-e', `
      let input = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => { input += chunk; });
      process.stdin.on('end', () => {
        const signed = JSON.parse(input);
        if (${fail}) { process.stderr.write('synthetic persistence refused'); process.exitCode = 23; }
        else process.stdout.write(JSON.stringify({ ...signed, attestation_id: 'fixture-id' }));
      });
    `], options));
  const record = () => recordSignedReviewedAttestation({ signed, env: {}, execFileImpl: poll.execFile,
    maxAttempts: 1, timeoutMs: 1000 });
  if (fail) await assert.rejects(record(), error => {
    assert.match(error.message, /exitCode=23/);
    assert.match(error.message, /synthetic persistence refused/);
    return true;
  });
  else assert.equal((await record()).attestation_id, 'fixture-id');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(['unhandledRejection', 'uncaughtException'].map(event => process.listeners(event)), handlers);
});

for (const delivery of ['missing-stdin', 'throwing-end', 'stream-error']) {
  test(`failed ${delivery} delivery drains the rejecting record promise`, async () => {
    const handlers = process.listeners('unhandledRejection');
    let settled = false;
    await assert.rejects(recordSignedReviewedAttestation({ signed, env: {}, maxAttempts: 1,
      execFileImpl: () => {
        const execution = new Promise((_resolve, reject) => setImmediate(() => {
          settled = true;
          reject(Object.assign(new Error('record command failed'), { code: 24, stderr: 'synthetic child cause' }));
        }));
        if (delivery !== 'missing-stdin') {
          const stdin = new EventEmitter();
          stdin.end = () => {
            const error = Object.assign(new Error('payload pipe failed'), { code: 'EPIPE' });
            if (delivery === 'throwing-end') throw error;
            stdin.emit('error', error);
          };
          execution.child = { stdin, kill() {} };
        }
        return execution;
      },
    }), /exitCode=24; stderr=synthetic child cause/);
    assert.equal(settled, true);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(process.listeners('unhandledRejection'), handlers);
  });
}

test('record diagnostics redact before retaining bounded stderr tail', () => {
  const details = attestationRecordErrorDetails({ code: 7,
    message: 'record refused', stderr: 'discard-prefix\n' + 'x'.repeat(3000)
      + '\npassword=fixture-password Bearer fixture-token '
      + 'postgres://fixture:credential@db.invalid/ledger '
      + 'hmac_key="fixture signing key" {"digest":"fixture-digest"} '
      + '/home/fixture/state/ledger.db fixture-environment-secret\nconstraint rejected',
  }, { HCP_TOKEN: 'fixture-environment-secret' });
  assert.equal(details.exitCode, 7);
  assert.ok(details.stderrTail.length <= 2000);
  assert.match(details.stderrTail, /constraint rejected$/);
  assert.doesNotMatch(details.error, /fixture-password|fixture-token|credential|fixture signing key|fixture-digest|fixture-environment-secret|\/home\/fixture|discard-prefix/);
});
