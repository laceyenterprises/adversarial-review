import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('../bin/verify-rebase-generated.py', import.meta.url));
for (const mode of ['valid', 'symlink-temp', 'mixed-case-repo', 'forged', 'mutated-source']) {
  const valid = !['forged', 'mutated-source'].includes(mode);
  test(`REBASEPROV-01 verifies raw merged-source generated output mode=${mode} without host state`, t => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'generated-verifier-')));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const source = join(root, 'source');
    const installed = join(root, 'installed');
    const pkg = join(installed, 'modules/worker-pool/lib/python/cwp_dispatch');
    const installedHelper = join(installed, 'tools/adversarial-review/bin/verify-rebase-generated.py');
    mkdirSync(join(installed, 'tools/adversarial-review/bin'), { recursive: true });
    writeFileSync(installedHelper, readFileSync(helper));
    for (const dir of [source, installed, pkg]) mkdirSync(dir, { recursive: true });
    const env = { ...process.env, PYTHONPATH: join(root, 'python'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    if (mode === 'symlink-temp') {
      const temp = join(root, 'real-temp');
      mkdirSync(temp);
      symlinkSync(temp, join(root, 'linked-temp'), 'dir');
      env.TMPDIR = join(root, 'linked-temp');
    }
    const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
    git(installed, 'init', '-q'); git(installed, 'remote', 'add', 'origin', mode === 'mixed-case-repo'
      ? 'git@example.invalid:Fixture/Repo.git' : 'git@example.invalid:fixture/repo.git');
    const shadow = join(root, 'python/cwp_dispatch');
    mkdirSync(shadow, { recursive: true });
    writeFileSync(join(shadow, '__init__.py'), `from pathlib import Path\nPath(${JSON.stringify(join(root, 'shadow-loaded'))}).touch()\nraise RuntimeError("worker policy must not load")\n`);
    writeFileSync(join(pkg, '__init__.py'), '');
    // A synthetic installed policy supplies a deterministic merged-source generator.
    writeFileSync(join(pkg, 'generated_conflicts.py'), `from pathlib import Path
from contextlib import nullcontext as termination_cleanup
REGISTRY_PATH = Path(${JSON.stringify(join(installed, 'modules/worker-pool/config/registry.json'))})
def load_registry():
    return {'generated.txt': {}}
def regenerate_conflicts(root, paths, trusted_root):
    assert trusted_root == Path(${JSON.stringify(installed)})
    for path in paths:
        (root / path).write_bytes((root / 'input.txt').read_bytes().upper())
    if ${mode === 'mutated-source' ? 'True' : 'False'}:
        (root / 'input.txt').write_text('mutated source')
    return True
`);
    git(source, 'init', '-q'); git(source, 'config', 'user.name', 'Fixture'); git(source, 'config', 'user.email', 'fixture@example.invalid');
    writeFileSync(join(source, 'input.txt'), 'merged input\n');
    writeFileSync(join(source, 'generated.txt'), mode !== 'forged' ? 'MERGED INPUT\n' : 'forged payload\n');
    writeFileSync(join(source, '.gitattributes'), 'input.txt export-ignore\n');
    git(source, 'add', '--all'); git(source, 'commit', '-qm', 'Merged sources');
    const sha = git(source, 'rev-parse', 'HEAD');
    const run = () => execFileSync('python3', [installedHelper, 'fixture/repo', 'verify', sha, 'generated.txt'], { cwd: source, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    if (valid) assert.equal(run().trim(), 'verified');
    else assert.throws(run, /Command failed/);
    assert.equal(readFileSync(join(source, 'generated.txt'), 'utf8'), mode !== 'forged' ? 'MERGED INPUT\n' : 'forged payload\n');
    assert.equal(git(source, 'status', '--porcelain'), '');
    assert.throws(() => execFileSync('python3', [installedHelper, 'fixture/other', 'policy'], { cwd: source, env, stdio: 'pipe' }));
    rmSync(pkg, { recursive: true });
    assert.throws(() => execFileSync('python3', [installedHelper, 'fixture/repo', 'policy'], { cwd: source, env, stdio: 'pipe' }));
    assert.equal(existsSync(join(root, 'shadow-loaded')), false, 'missing installed policy must not execute a worker package');
  });
}
