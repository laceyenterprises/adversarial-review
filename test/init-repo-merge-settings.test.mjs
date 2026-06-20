import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const thisFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(thisFile), '..');

function writeExecutable(filePath, body) {
  writeFileSync(filePath, body, 'utf8');
  chmodSync(filePath, 0o755);
}

test('merge settings initializer retries transient repo discovery and patch failures', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'merge-settings-retry-'));
  try {
    const ghPath = path.join(tmp, 'gh');
    const logPath = path.join(tmp, 'gh.log');
    const repoListCountPath = path.join(tmp, 'repo-list.count');
    const apiCountPath = path.join(tmp, 'api.count');
    writeExecutable(ghPath, `#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> "${logPath}"
if [[ "$1 $2" == "repo list" ]]; then
  count=0
  [[ -f "${repoListCountPath}" ]] && count="$(cat "${repoListCountPath}")"
  count=$((count + 1))
  echo "$count" > "${repoListCountPath}"
  if (( count == 1 )); then
    echo "TLS handshake timeout" >&2
    exit 1
  fi
  printf '%s\\n' 'laceyenterprises/foundry'
  exit 0
fi
if [[ "$1" == "api" ]]; then
  count=0
  [[ -f "${apiCountPath}" ]] && count="$(cat "${apiCountPath}")"
  count=$((count + 1))
  echo "$count" > "${apiCountPath}"
  if (( count == 1 )); then
    echo "HTTP 503 Service Unavailable" >&2
    exit 1
  fi
  printf '%s\\n' 'squash=true merge_commit=false rebase=false'
  exit 0
fi
exit 1
`);

    const result = spawnSync('bash', ['scripts/init-repo-merge-settings.sh', '--all'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${tmp}${path.delimiter}${process.env.PATH || ''}`,
        GH_RETRY_BASE_SLEEP_SECONDS: '0',
      },
    });

    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /ok\s+laceyenterprises\/foundry\s+squash=true merge_commit=false rebase=false/);
    assert.match(result.stderr, /retry gh \(1\/3\): transient failure: TLS handshake timeout/);
    assert.match(result.stderr, /retry gh \(1\/3\): transient failure: HTTP 503 Service Unavailable/);
    assert.equal(readFileSync(repoListCountPath, 'utf8').trim(), '2');
    assert.equal(readFileSync(apiCountPath, 'utf8').trim(), '2');

    const log = readFileSync(logPath, 'utf8');
    assert.match(log, /repo list laceyenterprises --limit 1000 --json nameWithOwner,isArchived/);
    assert.match(log, /api -X PATCH repos\/laceyenterprises\/foundry/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
