import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main } from '../src/check-branch-protection.mjs';

function makeWritable() {
  let text = '';
  return {
    write(chunk) {
      text += String(chunk);
    },
    toString() {
      return text;
    },
  };
}

function writeConfig(tmp, config) {
  const configPath = join(tmp, 'config.json');
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return configPath;
}

test('--json emits machine-readable results and persists missing/forbidden evidence', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'branch-protection-cli-'));
  try {
    const configPath = writeConfig(tmp, {
      repos: [
        'laceyenterprises/adversarial-review',
        'laceyenterprises/agent-os',
        'laceyenterprises/foundry',
      ],
    });
    const stdout = makeWritable();
    const stderr = makeWritable();
    const code = await main(
      ['--config', configPath, '--json', '--evidence-dir', tmp],
      {
        stdout,
        stderr,
        env: {
          GITHUB_TOKEN: 'token-123',
          PATH: '/usr/bin:/bin',
          HOME: tmp,
        },
        now: () => '2026-08-01T12:00:00.000Z',
        execFileImpl: async (_command, args) => {
          const endpoint = String(args[1] || '');
          if (endpoint.includes('adversarial-review/branches/main/protection')) {
            return { stdout: JSON.stringify({ required_status_checks: { contexts: ['ci/test'] } }) };
          }
          if (endpoint.includes('agent-os/branches/main/protection')) {
            const err = new Error('HTTP 403 Forbidden');
            err.stderr = 'HTTP 403 Forbidden';
            throw err;
          }
          if (endpoint.includes('foundry/branches/main/protection')) {
            return { stdout: JSON.stringify({ required_status_checks: { contexts: ['agent-os/adversarial-gate'] } }) };
          }
          throw new Error(`unexpected args: ${args.join(' ')}`);
        },
      },
    );

    assert.equal(code, 1);
    assert.equal(stderr.toString(), '');
    const payload = JSON.parse(stdout.toString());
    assert.equal(payload.schemaVersion, 1);
    assert.equal(payload.generatedAt, '2026-08-01T12:00:00.000Z');
    assert.equal(payload.summary.total, 3);
    assert.equal(payload.summary.ok, 1);
    assert.equal(payload.summary.requiredContextMissing, 1);
    assert.equal(payload.summary.forbidden, 1);
    assert.equal(payload.summary.exitCode, 1);

    const missing = payload.results.find((result) => result.repo === 'laceyenterprises/adversarial-review');
    const forbidden = payload.results.find((result) => result.repo === 'laceyenterprises/agent-os');
    const ok = payload.results.find((result) => result.repo === 'laceyenterprises/foundry');
    assert.equal(missing.ok, false);
    assert.equal(missing.reason, 'required-context-missing');
    assert.match(String(missing.evidencePath || ''), /adversarial-review--main\.json$/);
    assert.equal(forbidden.ok, false);
    assert.equal(forbidden.reason, 'branch-protection-forbidden');
    assert.match(String(forbidden.evidencePath || ''), /agent-os--main\.json$/);
    assert.equal(ok.ok, true);
    assert.equal(ok.evidencePath, undefined);

    const missingRecord = JSON.parse(readFileSync(missing.evidencePath, 'utf8'));
    assert.equal(missingRecord.action, 'apply-required-context');
    assert.match(missingRecord.manualCommand, /required_status_checks\/contexts/);

    const forbiddenRecord = JSON.parse(readFileSync(forbidden.evidencePath, 'utf8'));
    assert.equal(forbiddenRecord.action, 'manual-admin-required');
    assert.match(forbiddenRecord.manualCommand, /required_status_checks\/contexts/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('--apply adds the missing required context and exits clean when the patch succeeds', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'branch-protection-cli-apply-'));
  try {
    const configPath = writeConfig(tmp, {
      repos: ['laceyenterprises/adversarial-review'],
    });
    const stdout = makeWritable();
    const calls = [];
    const code = await main(
      ['--config', configPath, '--json', '--apply', '--evidence-dir', tmp],
      {
        stdout,
        env: {
          GITHUB_TOKEN: 'token-123',
          PATH: '/usr/bin:/bin',
          HOME: tmp,
        },
        now: () => '2026-08-01T12:34:56.000Z',
        execFileImpl: async (_command, args) => {
          calls.push(args);
          const endpoint = String(args.find((arg) => String(arg).includes('/branches/')) || '');
          if (args[0] === 'api' && endpoint.includes('/branches/main/protection') && !args.includes('-X')) {
            return { stdout: JSON.stringify({ required_status_checks: { contexts: ['ci/test'] } }) };
          }
          if (args[0] === 'api' && endpoint.includes('/required_status_checks/contexts') && args[2] === 'POST') {
            return { stdout: JSON.stringify(['ci/test', 'agent-os/adversarial-gate']) };
          }
          throw new Error(`unexpected args: ${args.join(' ')}`);
        },
      },
    );

    assert.equal(code, 0);
    const payload = JSON.parse(stdout.toString());
    assert.equal(payload.summary.ok, 1);
    assert.equal(payload.summary.applied, 1);
    assert.equal(payload.summary.exitCode, 0);
    assert.equal(payload.results[0].ok, true);
    assert.equal(payload.results[0].applied, true);
    assert.deepEqual(payload.results[0].requiredContexts, ['agent-os/adversarial-gate', 'ci/test']);
    assert.ok(
      calls.some((args) => args.some((arg) => String(arg).includes('/required_status_checks/contexts'))),
    );

    const record = JSON.parse(readFileSync(payload.results[0].evidencePath, 'utf8'));
    assert.equal(record.applied, true);
    assert.equal(record.action, 'applied-required-context');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('returns usage-style exit 2 when no repos are configured', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'branch-protection-cli-empty-'));
  try {
    const configPath = writeConfig(tmp, {});
    const stdout = makeWritable();
    const stderr = makeWritable();
    const code = await main(['--config', configPath], { stdout, stderr });
    assert.equal(code, 2);
    assert.equal(stdout.toString(), '');
    assert.match(stderr.toString(), /no repositories configured/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
