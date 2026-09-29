// Runs the hammer prompt's branch-protection fetch loop, verbatim from
// templates/hammer-prompt.md, against a stub `gh` that answers with the given
// stdout, stderr and exit code. HAMBG-02: the loop has to turn GitHub's real
// answers into a protection file that ama-check can decide on.

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PR_NUMBER = '4242';

export const GITHUB_PLAN_UNAVAILABLE_STDERR =
  'gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)';
export const BRANCH_NOT_PROTECTED_STDERR = 'gh: Branch not protected (HTTP 404)';
export const BRANCH_NOT_PROTECTED_STDOUT =
  '{"message":"Branch not protected","documentation_url":"https://docs.github.com/rest/branches/branch-protection#get-branch-protection","status":"404"}';

export function hammerProtectionFetchScript() {
  const template = readFileSync(join(REPO_ROOT, 'templates', 'hammer-prompt.md'), 'utf8');
  const start = template.indexOf('protection_err="/tmp/ham-<<PR_NUMBER>>-protection.stderr"');
  if (start < 0) throw new Error('hammer prompt has no protection fetch loop');
  const end = template.indexOf('\ndone\n', start);
  if (end < 0) throw new Error('hammer prompt protection fetch loop has no closing done');
  return template.slice(start, end + '\ndone\n'.length);
}

export function runHammerProtectionFetch({ stdout = '', stderr = '', exitCode = 1 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ham-protection-fetch-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const ghStub = join(bin, 'gh');
    writeFileSync(ghStub, [
      '#!/bin/sh',
      'printf \'%s\' "$STUB_GH_STDOUT"',
      '[ -z "$STUB_GH_STDERR" ] || printf \'%s\\n\' "$STUB_GH_STDERR" >&2',
      'exit "$STUB_GH_EXIT"',
      '',
    ].join('\n'));
    chmodSync(ghStub, 0o755);
    const protectionPath = join(dir, `ham-${PR_NUMBER}-protection.json`);
    const script = [
      'base_enc=main',
      'ham_release_merge_lease() { :; }',
      hammerProtectionFetchScript()
        .replaceAll('/tmp/ham-<<PR_NUMBER>>', join(dir, `ham-${PR_NUMBER}`))
        .replaceAll('<<REPO>>', 'laceyenterprises/example'),
    ].join('\n');
    const result = spawnSync('bash', ['-c', script], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        STUB_GH_STDOUT: stdout,
        STUB_GH_STDERR: stderr,
        STUB_GH_EXIT: String(exitCode),
      },
    });
    if (result.error) throw result.error;
    const protectionBody = existsSync(protectionPath) ? readFileSync(protectionPath, 'utf8') : null;
    return { status: result.status, stderr: result.stderr, protectionBody };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
