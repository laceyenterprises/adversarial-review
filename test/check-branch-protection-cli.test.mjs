import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { main } from '../src/check-branch-protection.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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

test('--json removes stale evidence when a repo is now compliant', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'branch-protection-cli-cleanup-'));
  try {
    const configPath = writeConfig(tmp, {
      repos: ['laceyenterprises/foundry'],
    });
    const stalePath = join(tmp, 'laceyenterprises__foundry--main.json');
    writeFileSync(stalePath, '{"ok":false}\n');
    const stdout = makeWritable();
    const code = await main(
      ['--config', configPath, '--json', '--evidence-dir', tmp],
      {
        stdout,
        env: {
          GITHUB_TOKEN: 'token-123',
          PATH: '/usr/bin:/bin',
          HOME: tmp,
        },
        execFileImpl: async () => ({
          stdout: JSON.stringify({
            required_status_checks: {
              contexts: ['agent-os/adversarial-gate'],
            },
          }),
        }),
      },
    );

    assert.equal(code, 0);
    const payload = JSON.parse(stdout.toString());
    assert.equal(payload.results[0].ok, true);
    assert.equal(payload.results[0].evidencePath, undefined);
    assert.equal(existsSync(stalePath), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('text mode does not write audit evidence', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'branch-protection-cli-text-'));
  try {
    const configPath = writeConfig(tmp, {
      repos: ['laceyenterprises/adversarial-review'],
    });
    const stdout = makeWritable();
    const stderr = makeWritable();
    const code = await main(
      ['--config', configPath, '--evidence-dir', tmp],
      {
        stdout,
        stderr,
        env: {
          GITHUB_TOKEN: 'token-123',
          PATH: '/usr/bin:/bin',
          HOME: tmp,
        },
        execFileImpl: async () => ({
          stdout: JSON.stringify({ required_status_checks: { contexts: ['ci/test'] } }),
        }),
      },
    );

    assert.equal(code, 1);
    assert.equal(stdout.toString(), '');
    assert.match(stderr.toString(), /required-context-missing/);
    assert.doesNotMatch(stderr.toString(), /\[branch-protection\] evidence/);
    assert.equal(existsSync(join(tmp, 'laceyenterprises__adversarial-review--main.json')), false);
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

test('--json creates a missing evidence directory before writing audit records', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'branch-protection-cli-missing-dir-'));
  try {
    const evidenceDir = join(tmp, 'missing', 'audits');
    const configPath = writeConfig(tmp, {
      repos: ['laceyenterprises/adversarial-review'],
    });
    const stdout = makeWritable();
    const code = await main(
      ['--config', configPath, '--json', '--evidence-dir', evidenceDir],
      {
        stdout,
        env: {
          GITHUB_TOKEN: 'token-123',
          PATH: '/usr/bin:/bin',
          HOME: tmp,
        },
        now: () => '2026-08-01T12:00:00.000Z',
        execFileImpl: async () => ({
          stdout: JSON.stringify({ required_status_checks: { contexts: ['ci/test'] } }),
        }),
      },
    );

    assert.equal(code, 1);
    assert.equal(existsSync(evidenceDir), true);
    const payload = JSON.parse(stdout.toString());
    assert.equal(existsSync(payload.results[0].evidencePath), true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('default shared evidence directory refuses writes from a mismatched uid', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'branch-protection-cli-owner-guard-'));
  try {
    const configPath = writeConfig(tmp, {
      repos: ['laceyenterprises/adversarial-review'],
    });
    const stdout = makeWritable();
    const stderr = makeWritable();
    const checkoutOwnerUid = statSync(REPO_ROOT).uid;
    const code = await main(
      ['--config', configPath, '--json'],
      {
        stdout,
        stderr,
        env: {
          GITHUB_TOKEN: 'token-123',
          PATH: '/usr/bin:/bin',
          HOME: tmp,
        },
        processImpl: {
          getuid: () => checkoutOwnerUid + 1,
        },
        execFileImpl: async () => {
          throw new Error('gh api should not run after owner guard refusal');
        },
      },
    );

    assert.equal(code, 4);
    assert.equal(stdout.toString(), '');
    assert.match(stderr.toString(), /refusing to write shared branch-protection audit state/);
    assert.match(stderr.toString(), /data\/branch-protection-audits/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('--json renders repo-root evidence directory as a stable relative dot path', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'branch-protection-cli-root-dir-'));
  try {
    const configPath = writeConfig(tmp, {
      repos: ['laceyenterprises/adversarial-review'],
    });
    const stdout = makeWritable();
    const code = await main(
      ['--config', configPath, '--json', '--evidence-dir', REPO_ROOT],
      {
        stdout,
        env: {
          GITHUB_TOKEN: 'token-123',
          PATH: '/usr/bin:/bin',
          HOME: tmp,
        },
        execFileImpl: async () => ({
          stdout: JSON.stringify({
            required_status_checks: {
              contexts: ['agent-os/adversarial-gate'],
            },
          }),
        }),
      },
    );

    assert.equal(code, 0);
    const payload = JSON.parse(stdout.toString());
    assert.equal(payload.evidenceDir, '.');
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
