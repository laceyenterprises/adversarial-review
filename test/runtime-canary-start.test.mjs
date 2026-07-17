import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const wrapper = resolve('scripts/adversarial-runtime-canary-start.sh');

function executable(path, body) {
  writeFileSync(path, body, 'utf8');
  chmodSync(path, 0o755);
}

test('canary wrapper retries a transient op failure before launching node with the recipient', (t) => {
  if (!existsSync('/bin/zsh')) {
    t.skip('/bin/zsh is unavailable on this runner');
    return;
  }
  const rootDir = mkdtempSync(join(tmpdir(), 'canary-wrapper-'));
  const binDir = join(rootDir, 'bin');
  try {
    mkdirSync(binDir);
    executable(join(binDir, 'node'), '#!/bin/zsh\nprint -r -- "$ADVERSARIAL_REVIEW_ALERT_TO"\n');
    executable(join(binDir, 'op'), `#!/bin/zsh
count_file="${rootDir}/attempts"
count=0
[[ -f "$count_file" ]] && count="$(<"$count_file")"
(( count += 1 ))
print -r -- "$count" > "$count_file"
(( count < 2 )) && { print -u2 'temporary network failure'; exit 1; }
print -r -- 'operator@example.test'
`);
    writeFileSync(join(rootDir, '.zshenv'), `export PATH='${binDir}:/usr/bin:/bin'\n`, 'utf8');
    const result = spawnSync('/bin/zsh', [wrapper, '--fixture'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}:/usr/bin:/bin`,
        ZDOTDIR: rootDir,
        ADVERSARIAL_REVIEW_DIR: rootDir,
        ADVERSARIAL_REVIEW_ALERT_TO: '',
        ADVERSARIAL_REVIEW_ALERT_TO_OP_REF: 'op://vault/item/field',
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'operator@example.test');
    assert.equal(readFileSync(join(rootDir, 'attempts'), 'utf8').trim(), '2');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
