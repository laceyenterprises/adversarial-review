import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildMergeAgentPrompt } from '../src/merge-agent-prompt.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = path => readFileSync(join(root, path), 'utf8');
const prs = [1720, 1722, 1725, 1726, 1727];

// Real Git branches in a standalone fixture; never switch or write caller refs.
for (const fragments of [false, true]) {
  test(`ARROOTNOTES-01: five independent ${fragments ? 'ticket records merge' : 'README insertions conflict'}`, t => {
    const dir = mkdtempSync(join(tmpdir(), 'ar-notes-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const gitEnv = Object.fromEntries(Object.entries(process.env)
      .filter(([key]) => !key.startsWith('GIT_')));
    const git = (...args) => spawnSync('git', ['-c', 'core.hooksPath=/dev/null',
      '-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture',
      '-c', 'user.email=fixture@example.invalid', ...args], {
      cwd: dir, encoding: 'utf8', timeout: 10_000,
      env: { ...gitEnv, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' },
    });
    const ok = (...args) => {
      const result = git(...args);
      assert.equal(result.status, 0, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
      return result.stdout;
    };
    ok('init', '-b', 'base');
    const original = read('README.md');
    writeFileSync(join(dir, 'README.md'), original);
    mkdirSync(join(dir, 'docs/changes'), { recursive: true });
    ok('add', 'README.md');
    ok('commit', '-m', 'base');
    for (const pr of prs) {
      ok('checkout', '-b', `pr-${pr}`, 'base');
      const note = `Independent note for PR ${pr}.\n`;
      if (fragments) {
        mkdirSync(join(dir, 'docs/changes'), { recursive: true });
        writeFileSync(join(dir, `docs/changes/PR-${pr}.md`), note);
      }
      else writeFileSync(join(dir, 'README.md'), original.replace('## Change notes\n', `## Change notes\n\n${note}`));
      // Stand in for disjoint reviewed implementation files.
      writeFileSync(join(dir, `implementation-${pr}.txt`), `work ${pr}\n`);
      ok('add', fragments ? `docs/changes/PR-${pr}.md` : 'README.md', `implementation-${pr}.txt`);
      ok('commit', '-m', `PR ${pr}`);
    }
    for (const [order, sequence] of [prs, [...prs].reverse()].entries()) {
      ok('checkout', '-b', `integration-${order}`, 'base');
      ok('merge', '--no-edit', `pr-${sequence[0]}`);
      for (const pr of sequence.slice(1)) {
        const result = git('merge', '--no-edit', `pr-${pr}`);
        if (fragments) assert.equal(result.status, 0, result.stdout + result.stderr);
        else {
          assert.equal(result.status, 1, result.stdout + result.stderr);
          assert.equal(ok('diff', '--name-only', '--diff-filter=U').trim(), 'README.md');
          ok('merge', '--abort');
        }
      }
      if (fragments) {
        assert.equal(readFileSync(join(dir, 'README.md'), 'utf8'), original);
        for (const pr of prs) {
          assert.equal(readFileSync(join(dir, `docs/changes/PR-${pr}.md`), 'utf8'), `Independent note for PR ${pr}.\n`);
          assert.equal(readFileSync(join(dir, `implementation-${pr}.txt`), 'utf8'), `work ${pr}\n`);
        }
      }
    }
  });
}

test('repository convention is discoverable to builders and every affected prompt reader', () => {
  assert.match(read('AGENTS.md'), /docs\/changes\/<TICKET-ID>\.md/);
  assert.match(read('README.md'), /\[.*docs\/changes\/.*\]\(docs\/changes\/README\.md\)/);
  assert.match(read('docs/changes/README.md'), /Summary, Interface changes \(or none\), and Verification/);
  assert.match(read('docs/changes/README.md'), /src\/changes\/\*\.md` are historical/);
  const readers = ['templates/hammer-prompt.md', 'docs/RUNBOOK-ama-closure.md',
    'docs/SPEC-adversarial-review-auto-remediation.md', 'docs/follow-up-runbook.md'];
  for (const role of ['reviewer', 'remediator']) {
    for (const stage of ['first', 'middle', 'last']) readers.push(`prompts/code-pr/${role}.${stage}.md`);
  }
  const prompts = readers.map(read);
  prompts.push(buildMergeAgentPrompt({ repo: 'fixture/repo', prNumber: 42, baseBranch: 'main' }));
  for (const raw of prompts) {
    const text = raw.replace(/\s+/g, ' ');
    assert.match(text, /accept its per-ticket records without requesting a shared root README entry/);
    assert.match(text, /does not replace required in-place canonical contract corrections/);
    assert.match(text, /docs\/data-model\//);
  }
});
