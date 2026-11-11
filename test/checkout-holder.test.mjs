import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { runHelperStep } from '../bin/hammer-helper-step.mjs';
import { releaseCheckoutHolder } from '../src/ama/checkout-holder.mjs';
import { samePrHammerHolderWorktreePaths } from '../src/ama/branch-holder-paths.mjs';

const exec = promisify(execFile);
for (const state of ['terminal', 'live', 'dirty', 'uncertain', 'release-failed', 'reacquired']) {
  test(`checkout collision with ${state} holder`, async t => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'checkout-holder-')));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const root = join(dir, 'hq');
    const repo = join(dir, 'repo');
    const holder = join(root, 'workers', 'builder', 'repo');
    const closer = join(root, 'workers', 'closer', 'repo');
    mkdirSync(repo); mkdirSync(join(root, 'workers', 'builder'), { recursive: true });
    mkdirSync(join(root, 'workers', 'closer'));
    const git = (path, ...args) => execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git(repo, 'init', '-b', 'main');
    git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'base');
    git(repo, 'worktree', 'add', '-b', 'feature', holder);
    git(repo, 'worktree', 'add', '--detach', closer, 'main');
    if (state === 'dirty') writeFileSync(join(holder, 'local-work'), 'preserve\n');
    const before = git(holder, 'rev-parse', 'HEAD');
    let requests = 0, checkoutCalls = 0, errors = '';
    const reports = [];
    const previous = process.cwd();
    process.chdir(closer);
    try {
      const code = await runHelperStep({ mode: 'mutation:report', step: 'checkout', nominal: 5, ceiling: 5,
        command: 'git', args: ['checkout', 'feature'], env: { ...process.env, HAM_HQ_ROOT: root } }, {
        budget: () => 5, stdout: () => {}, stderr: text => { errors += text; },
        report: reason => reports.push(reason),
        releaseHolder: async options => {
          checkoutCalls++;
          return releaseCheckoutHolder(options, { execFileImpl: async (cmd, args, opts) => {
            if (cmd !== 'hq') return exec(cmd, args, opts);
            requests++;
            assert.deepEqual(args, ['worker', 'release-branch', '--root', root, '--holder', holder, '--branch', 'feature']);
            if (!['terminal', 'reacquired'].includes(state)) throw new Error('holder retained');
            git(holder, 'update-ref', 'refs/hq/salvage/builder/output', before);
            git(holder, 'checkout', '--detach');
            if (state === 'reacquired') {
              const competitor = join(root, 'workers', 'competitor', 'repo');
              mkdirSync(join(root, 'workers', 'competitor'));
              git(repo, 'worktree', 'add', competitor, 'feature');
            }
            return { stdout: '{}' };
          } });
        },
      });
      assert.equal(requests, 1); assert.equal(checkoutCalls, 1);
      assert.match(errors, new RegExp(`holder=${holder}`));
      assert.equal(git(holder, 'rev-parse', 'HEAD'), before);
      if (state === 'terminal') {
        assert.equal(code, 0, errors);
        assert.deepEqual(reports, []);
        assert.equal(git(closer, 'branch', '--show-current'), 'feature');
        assert.equal(git(holder, 'branch', '--show-current'), '');
      } else {
        assert.notEqual(code, 0);
        assert.deepEqual(reports, ['checkout-failed']);
        assert.equal(git(holder, 'branch', '--show-current'), state === 'reacquired' ? '' : 'feature');
        assert.equal(git(closer, 'branch', '--show-current'), '');
      }
    } finally { process.chdir(previous); }
  });
}

test('checkout recovery never executes arbitrary mutations or ambiguous diagnostics', async () => {
  for (const args of [['checkout', '-f', 'feature'], ['checkout', '-b', 'feature'], ['reset', '--hard'], ['checkout', '--', 'file']]) {
    assert.equal(await releaseCheckoutHolder({ command: 'git', args, errors: '', env: {}, stderr: () => {} }), false);
  }
});

test('canonical parser recognizes both Git checkout collision wordings', () => {
  const root = '/synthetic/hq';
  const holder = `${root}/workers/builder/repo`;
  for (const wording of ['already used by worktree at', 'already checked out at', 'already checked out in worktree']) {
    assert.deepEqual(samePrHammerHolderWorktreePaths(`fatal: 'feature' is ${wording} '${holder}'`, null, root), [holder]);
  }
  assert.deepEqual(samePrHammerHolderWorktreePaths("fatal: 'feature' is already checked out at '/other/repo'", null, root), []);
});
