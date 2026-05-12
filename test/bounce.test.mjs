import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BOUNCE_SCRIPT = path.join(ROOT, 'tools', 'adversarial-review', 'bounce.sh');

function writeExecutable(filePath, contents) {
  writeFileSync(filePath, contents, 'utf8');
  chmodSync(filePath, 0o755);
}

test('bounce.sh restarts the supervisor and clears the drain marker even when reviewer drain times out', async (t) => {
  const repoDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-bounce-'));
  t.after(() => rmSync(repoDir, { recursive: true, force: true }));
  const scriptDir = path.join(repoDir, 'tools', 'adversarial-review');
  const binDir = path.join(repoDir, 'bin');
  mkdirSync(scriptDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(path.join(scriptDir, 'bounce.sh'), readFileSync(BOUNCE_SCRIPT, 'utf8'), 'utf8');
  chmodSync(path.join(scriptDir, 'bounce.sh'), 0o755);

  const serviceLog = path.join(repoDir, 'service.log');
  writeExecutable(
    path.join(binDir, 'node'),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "-e" ]] && [[ "\${2:-}" == *"SELECT DISTINCT reviewer_pgid AS pgid"* ]]; then
  echo 4242
  exit 0
fi
exec "${process.execPath}" "$@"
`
  );
  writeExecutable(path.join(binDir, 'uname'), '#!/usr/bin/env bash\necho Linux\n');
  writeExecutable(
    path.join(binDir, 'systemctl'),
    `#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> "${serviceLog}"
`
  );

  const result = spawn(
    'bash',
    [path.join(scriptDir, 'bounce.sh'), 'adversarial-review.service'],
    {
      cwd: repoDir,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        BOUNCE_DRAIN_TIMEOUT_SECONDS: '0',
      },
      stdio: 'pipe',
    }
  );

  let stderr = '';
  for await (const chunk of result.stderr) {
    stderr += chunk.toString();
  }
  const exitCode = await new Promise((resolve) => result.on('close', resolve));

  assert.equal(exitCode, 1);
  assert.match(stderr, /drain timed out; restarting systemd service anyway/);
  assert.equal(readFileSync(serviceLog, 'utf8'), '--user stop adversarial-review.service\n--user start adversarial-review.service\n');
  assert.throws(
    () => readFileSync(path.join(repoDir, 'data', 'watcher-drain.json'), 'utf8'),
    /ENOENT/
  );
});
