import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderHammerProcedure, HAMMER_PHASES, splitHammerPrompt } from '../src/hammer-procedure.mjs';

test('copied procedures identify their source generation without changing the executable header', () => {
  for (const phase of HAMMER_PHASES) {
    const source = readFileSync(new URL(`../bin/${phase}.sh`, import.meta.url));
    const expected = createHash('sha256').update(source).digest('hex');
    const values = Object.fromEntries([...source.toString().matchAll(/<<([A-Z_]+)>>/g)].map(([, key]) => [key, 'fixture']));
    const rendered = renderHammerProcedure(phase, values);
    assert.ok(rendered.startsWith(`#!/usr/bin/env bash\n# hammer-procedure-source-sha256: ${expected}\n`));
    assert.equal(rendered, renderHammerProcedure(phase, values));
    assert.equal(rendered.match(/hammer-procedure-source-sha256:/g).length, 1);
  }
});

test('rendered phase receipts are emitted by phase outcomes without changing merge fences', () => {
  for (const phase of HAMMER_PHASES) {
    const source = readFileSync(new URL(`../bin/${phase}.sh`, import.meta.url), 'utf8');
    const values = Object.fromEntries([...source.matchAll(/<<([A-Z_]+)>>/g)].map(([, key]) => [key, 'fixture']));
    const rendered = renderHammerProcedure(phase, values);
    assert.doesNotMatch(rendered, /HAM_NODE_BIN:-node/);
    // A no-merge merge outcome can be retried in-run, so phases never record terminal-stop.
    assert.doesNotMatch(rendered, /terminal-stop/);
    if (phase !== 'hammer-merge') assert.ok(rendered.includes('/bin/hammer-progress.mjs'));
    if (phase === 'hammer-verify-head') {
      assert.match(rendered, /HAM_PHASE_OUTCOME=verified\n.*verify-head/);
      assert.match(rendered, /export HAM_PUSHED_FROM_HEAD HAM_PUSHED_HEAD\n.*remediation-pushed/);
    }
    if (phase === 'hammer-publish') assert.match(rendered, /remediation-pushed/);
    if (phase === 'hammer-merge') {
      assert.match(rendered, /hammer-progress\.mjs --phase/);
      assert.doesNotMatch(rendered, /hammer-progress\.mjs.*terminal-stop/);
      assert.match(rendered, /--match-head-commit "\$POST_REMEDIATION_SHA"/);
    }
  }
});

test('phase receipt failures warn once and preserve execution under errexit', () => {
  for (const phase of HAMMER_PHASES) {
    const source = readFileSync(new URL(`../bin/${phase}.sh`, import.meta.url), 'utf8');
    const values = Object.fromEntries([...source.matchAll(/<<([A-Z_]+)>>/g)].map(([, key]) => [key, 'fixture']));
    values.ROOT_DIR = fileURLToPath(new URL('../', import.meta.url));
    const rendered = renderHammerProcedure(phase, values);
    const calls = rendered.split('\n').filter(line => line.includes('/bin/hammer-progress.mjs'));
    assert.ok(phase === 'hammer-merge' || calls.length > 0);
    for (const call of calls) {
      const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-euc', `${call}\nprintf 'continued'`], {
        env: { ...process.env, HAM_NODE_BIN: process.execPath, ham_audit_reason: 'checks-red', ham_phase_reason: 'checks-red',
          HAM_API_KNOWN_PUSHED_HEAD: 'a'.repeat(40), HAM_PUSHED_HEAD: 'b'.repeat(40),
          HQ_WORKER_RUN_ID: 'invalid-run' },
        encoding: 'utf8', timeout: 5000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, 'continued');
      assert.equal(result.stderr, call.includes('--phase') ? '' : 'HAM progress receipt unavailable\n');
    }
  }
});

test('reference extraction preserves complete appendix content and refuses broken markers', () => {
  const content = 'Mandatory rule.\n\n```bash\nsource "$INPUTS"\n```';
  const template = `Core rule.\n<!-- hammer-reference:B1 -->\n${content}\n<!-- /hammer-reference:B1 -->\nTail rule.`;
  const result = splitHammerPrompt(template);
  assert.match(result.prompt, /Core rule/);
  assert.match(result.prompt, /Read \*\*Appendix B1\*\*.*<<RUN_DIR>>\/hammer-reference.md/);
  assert.match(result.prompt, /Tail rule/);
  assert.ok(result.reference.includes(content));
  assert.throws(() => splitHammerPrompt(template.replace('/hammer-reference:B1', '/hammer-reference:E1')), /malformed/);
  assert.deepEqual(splitHammerPrompt('Unchanged fixture'), { prompt: 'Unchanged fixture', reference: '' });
});

test('HAMPROMPT-01: rendered outcome routing names an action without changing phase status', t => {
  const dir = mkdtempSync(join(tmpdir(), 'hammer-outcome-routing-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = join(dir, 'phase.sh');
  for (const [phase, status, publicationOnly, next] of [
    ['hammer-verify-head', 0, 0, /Appendix C revalidation/],
    ['hammer-verify-head', 20, 0, /stop with fixture-refusal/],
    ['hammer-verify-head', 21, 0, /Appendix D.*re-enter verify-head/],
    ['hammer-verify-head', 1, 0, /stop with fixture-refusal/],
    ['hammer-publish', 0, 1, /unset HAM_COMMIT_PUBLICATION_ONLY.*run verify-head/],
    ['hammer-publish', 0, 0, /Appendix E wait for exact-head checks/],
    ['hammer-publish', 0, 'true', /Appendix E wait for exact-head checks/],
    ['hammer-publish', 0, 'yes', /Appendix E wait for exact-head checks/],
    ['hammer-publish', 0, '', /Appendix E wait for exact-head checks/],
    ['hammer-publish', 1, 0, /stop with fixture-refusal/],
    ['hammer-merge', 0, 0, /confirmed-merge closing audit/],
    ['hammer-merge', 21, 0, /Appendix D.*re-enter verify-head/],
    ['hammer-merge', 75, 0, /stop with fixture-refusal/],
  ]) {
    const source = readFileSync(new URL(`../bin/${phase}.sh`, import.meta.url), 'utf8');
    const values = Object.fromEntries([...source.matchAll(/<<([A-Z_]+)>>/g)].map(([, key]) => [key, 'fixture']));
    // Stub only the phase's execution; run the production renderer's complete
    // return/audit/routing wrapper without credentials, network or live state.
    const rendered = renderHammerProcedure(phase, values)
      .replace('ham_run_rendered_phase "$@"', `HAM_PHASE_OUTCOME=fixture-refusal\n(exit ${status})`);
    // Node may use a socket for piped stdin on Linux; /dev/stdin cannot reopen
    // that socket. Source a real file, as the dispatched closer does.
    writeFileSync(script, rendered);
    const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', 'source "$1"', 'bash', script], {
      encoding: 'utf8', timeout: 5000,
      env: { PATH: process.env.PATH, HAM_NODE_BIN: '/usr/bin/true',
        HAM_COMMIT_PUBLICATION_ONLY: String(publicationOnly) },
    });
    assert.ifError(result.error);
    assert.equal(result.status, status, result.stderr);
    assert.match(result.stderr, next);
    assert.doesNotMatch(result.stderr, /sed -n|rg |grep |integer expression expected/);
  }
});

test('publication dispatch treats non-numeric flags as ordinary audit publication without shell errors', () => {
  const source = readFileSync(new URL('../bin/hammer-publish.sh', import.meta.url), 'utf8');
  const dispatch = source.slice(source.indexOf('# Called before the hammer'));
  assert.ok(dispatch.length < source.length, 'exercise the production publication dispatch');
  for (const flag of ['true', 'yes', '', '0']) {
    const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-uc', `
ham_publish_phase() { echo audit-publication; }
publish() {
${dispatch.replaceAll(/<<[A-Z_]+>>/g, 'fixture')}
}
publish
`], {
      encoding: 'utf8', timeout: 5000,
      env: { PATH: process.env.PATH, HAM_COMMIT_PUBLICATION_ONLY: flag },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'audit-publication\n');
    assert.equal(result.stderr, '');
  }
});

test('CLOSERCIWAIT-01: deployed claim binder reads the exported phase head and preserves claims', t => {
  const dir = mkdtempSync(join(tmpdir(), 'hammer-claim-head-'));
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  const path = join(dir, 'claim.json');
  const original = { active: true, commit: { sha: 'old', parentSha: 'parent' }, auditComment: { findings: ['synthetic finding'] } };
  writeFileSync(path, JSON.stringify(original));
  const head = 'a'.repeat(40);
  const helper = fileURLToPath(new URL('../bin/hammer-claim-head.mjs', import.meta.url));
  const env = { ...process.env, POST_REMEDIATION_SHA: head };
  delete env.HAM_AUDIT_COMMENT_BODY;
  const result = spawnSync(process.execPath, [helper, path], {
    env, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(path)), { ...original, commit: { ...original.commit, sha: head } });
  const failed = spawnSync(process.execPath, [helper, path], {
    env: { ...process.env, POST_REMEDIATION_SHA: '' }, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /claim-build-failed/);
  assert.equal(JSON.parse(readFileSync(path)).commit.sha, head);
});

test('claim binder refreshes the published audit body and refuses stale or ambiguous head evidence without writing', t => {
  const dir = mkdtempSync(join(tmpdir(), 'hammer-claim-audit-'));
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  const path = join(dir, 'claim.json');
  const head = 'a'.repeat(40), oldHead = 'b'.repeat(40);
  const original = { commit: { sha: oldHead }, auditComment: {
    body: `HAM-Validated-Head: ${oldHead}`, findings: ['keep finding'], docCurrency: { status: 'updated' },
  } };
  const helper = fileURLToPath(new URL('../bin/hammer-claim-head.mjs', import.meta.url));
  for (const body of ['', `HAM-Validated-Head: ${oldHead}`,
    `HAM-Validated-Head: ${head}\nHAM-Validated-Head: ${head}`,
    `Audit details\nHAM-Validated-Head: ${head}`]) {
    writeFileSync(path, JSON.stringify(original));
    const result = spawnSync(process.execPath, [helper, path], {
      env: { ...process.env, POST_REMEDIATION_SHA: head, HAM_AUDIT_COMMENT_BODY: body },
      encoding: 'utf8', timeout: 5000,
    });
    const valid = body === `Audit details\nHAM-Validated-Head: ${head}`;
    assert.equal(result.status, valid ? 0 : 1, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(path)), valid
      ? { commit: { sha: head }, auditComment: { ...original.auditComment, body } } : original);
  }
});

// Full phase entrypoints run against an executable fake; it rejects every
// operation except the read-only lease-status query. No credentials are passed.
test('HAMNODEBIN-01: every resumed phase resolves and exports Node before querying lease status', t => {
  const dir = mkdtempSync(join(tmpdir(), 'hammer-node-runtime-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const fake = join(bin, 'node');
  writeFileSync(fake, `#!/bin/bash
case "$1:$2" in
  */merge-lease.mjs:status) printf 'synthetic-lease-status\\n'; exit 0 ;;
esac
exit 1
`, { mode: 0o755 });
  const root = fileURLToPath(new URL('../', import.meta.url));
  for (const phase of HAMMER_PHASES) {
    const source = readFileSync(new URL(`../bin/${phase}.sh`, import.meta.url), 'utf8');
    const values = Object.fromEntries([...source.matchAll(/<<([A-Z_]+)>>/g)].map(([, key]) => [key, 'fixture']));
    Object.assign(values, { ROOT_DIR: root, RUN_DIR: dir, PR_NUMBER: '17', REPO: 'example/project' });
    const script = join(dir, `${phase}.sh`);
    writeFileSync(script, renderHammerProcedure(phase, values));
    for (const pin of [undefined, '', fake]) {
      const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-uc', `
source "$1" >/dev/null 2>/dev/null
[ "$HAM_NODE_BIN" = "$2" ] || exit 91
# Cross a child-shell boundary to verify the resolved runtime is exported.
/bin/bash -uc '"$HAM_NODE_BIN" "$1/bin/merge-lease.mjs" status --repo example/project --base main' bash "$3"
`, 'bash', script, fake, root], {
        encoding: 'utf8', timeout: 5000,
        env: { PATH: `${bin}:${process.env.PATH}`, ...(pin === undefined ? {} : { HAM_NODE_BIN: pin }),
          ...(pin === fake ? { AGENT_OS_NODE_BIN: '/synthetic/missing-node' } : {}) },
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, `${phase}: ${result.stderr}`);
      assert.equal(result.stdout, 'synthetic-lease-status\n');
    }
    // Invalid explicit pins must not fall back to the executable PATH fake.
    const nonExecutable = join(dir, 'non-executable');
    writeFileSync(nonExecutable, '#!/bin/bash\nexit 0\n');
    chmodSync(nonExecutable, 0o644);
    for (const invalid of [join(dir, 'missing'), 'node', dir, nonExecutable]) {
      for (const argv of [['-c', 'source "$1"', 'bash', script], [script]]) {
        const result = spawnSync('/bin/bash', argv, {
          encoding: 'utf8', timeout: 5000,
          env: { PATH: `${bin}:${process.env.PATH}`, HAM_NODE_BIN: invalid },
        });
        assert.ifError(result.error);
        assert.notEqual(result.status, 0, phase);
        assert.match(result.stderr, /node-runtime-unavailable/);
        assert.match(result.stderr, /HAM terminal failure audit unavailable/);
        assert.doesNotMatch(result.stderr, /No such file or directory|command not found|Permission denied|is a directory/);
        assert.doesNotMatch(result.stdout, /synthetic-lease-status/);
      }
    }
  }
});

test('HAMNODEBIN-01: failed runtime resolution clears invalid pins in the caller and child shells', t => {
  const dir = mkdtempSync(join(tmpdir(), 'hammer-invalid-runtime-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const resolver = fileURLToPath(new URL('../bin/hammer-node-runtime.sh', import.meta.url));
  const nonExecutable = join(dir, 'non-executable');
  writeFileSync(nonExecutable, '#!/bin/bash\nexit 0\n', { mode: 0o644 });
  for (const pinName of ['HAM_NODE_BIN', 'AGENT_OS_NODE_BIN']) {
    for (const invalid of [join(dir, 'missing'), 'node', dir, nonExecutable]) {
      const result = spawnSync('/bin/bash', ['-uc', `
if source "$1"; then exit 91; fi
[ "\${HAM_NODE_BIN+x}" != x ] || exit 92
[ "$HAM_PHASE_OUTCOME" = node-runtime-unavailable ] || exit 93
/bin/bash -uc '[ "\${HAM_NODE_BIN+x}" != x ]'
`, 'bash', resolver], {
        env: { PATH: process.env.PATH, [pinName]: invalid },
        encoding: 'utf8', timeout: 5000,
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, `${pinName}: ${result.stderr}`);
      assert.match(result.stderr, /node-runtime-unavailable/);
    }
  }
});

test('HAMNODEBIN-01: persisted resume inputs restore the runtime and honor the launch pin', t => {
  const dir = mkdtempSync(join(tmpdir(), 'hammer-resume-inputs-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = fileURLToPath(new URL('../', import.meta.url));
  const template = readFileSync(new URL('../templates/hammer-prompt.md', import.meta.url), 'utf8');
  const inputs = template.match(/<<'HAM_INPUTS'\n([\s\S]*?)\nHAM_INPUTS/)[1];
  writeFileSync(join(dir, 'base-head'), 'a'.repeat(40));
  const script = join(dir, 'inputs.sh');
  writeFileSync(script, inputs.replaceAll('<<ROOT_DIR>>', root).replaceAll('<<RUN_DIR>>', dir)
    .replaceAll(/<<[A-Z_]+>>/g, 'fixture'));
  const result = spawnSync('/bin/bash', ['-euc', `source "$1"
unset HAM_NODE_BIN
source "$1"
/bin/bash -uc 'printf "%s" "$HAM_NODE_BIN"'
`, 'bash', script], {
    env: { PATH: process.env.PATH, AGENT_OS_NODE_BIN: process.execPath },
    encoding: 'utf8', timeout: 5000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, process.execPath);
  // After sourcing, helpers must require the resolved export rather than
  // silently launching a PATH runtime if the caller loses it.
  const fallback = join(dir, 'node');
  writeFileSync(fallback, '#!/bin/bash\nprintf unexpected-PATH-runtime\n', { mode: 0o755 });
  for (const helper of ['ham_gh', 'ham_git', 'ham_pr']) {
    const lost = spawnSync('/bin/bash', ['-c', 'source "$1" || exit; unset HAM_NODE_BIN; "$2" fixture', 'bash', script, helper], {
      env: { PATH: `${dir}:${process.env.PATH}`, AGENT_OS_NODE_BIN: process.execPath },
      encoding: 'utf8', timeout: 5000,
    });
    assert.ifError(lost.error);
    assert.notEqual(lost.status, 0, helper);
    assert.equal(lost.stdout, '', helper);
  }
  const emptyPath = join(dir, 'empty-path');
  mkdirSync(emptyPath);
  const missing = spawnSync('/bin/bash', ['-c', 'source "$1"', 'bash', join(root, 'bin/hammer-node-runtime.sh')], {
    env: { PATH: emptyPath }, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /node-runtime-unavailable/);
});
