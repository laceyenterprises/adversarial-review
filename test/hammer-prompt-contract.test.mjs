import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { documentedExamples, assertExternalCommands } from './helpers/hammer-prompt-contract.mjs';
import { amaAllAuthoritativeReviewerLogins } from '../src/ama/reviewer-authority.mjs';
import { openReviewStateDb, ensureReviewStateSchema } from '../src/review-state.mjs';

const root = resolve(import.meta.dirname, '..');
const template = readFileSync(join(root, 'templates/hammer-prompt.md'), 'utf8');
const shellHelpers = readFileSync(join(root, 'bin/hammer-shell-helpers.sh'), 'utf8');
const functions = new Set([...`${template}\n${shellHelpers}`.matchAll(/\b(ham_\w+)\(\)/g)].map(m => m[1]));
const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const preload = fileURLToPath(new URL('./fixtures/hammer-prompt-clock.mjs', import.meta.url));

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'hammer-prompt-contract-'));
  const children = new Set();
  const killGroup = (child, signal = 'SIGKILL') => {
    if (!child.pid) return;
    // Descendants can retain the group and its pipes after bash exits.
    try { process.kill(-child.pid, signal); } catch (error) {
      if (error.code === 'EPERM' && (child.exitCode !== null || child.signalCode !== null)) return;
      if (error.code !== 'ESRCH') throw error;
    }
  };
  t.after(() => {
    for (const child of children) killGroup(child);
    rmSync(dir, { recursive: true, force: true });
  });
  const run = join(dir, 'run');
  const checkout = join(dir, 'checkout');
  const fakeBin = join(dir, 'fake-bin');
  for (const path of [run, checkout, fakeBin]) mkdirSync(path);
  for (const name of ['bin', 'src', 'domains']) symlinkSync(join(root, name), join(dir, name), 'dir');
  writeFileSync(join(dir, 'config.yaml'), '{}\n');
  writeFileSync(join(dir, 'root-config.yaml'), 'version: 1\n');
  const env = {
    // Do not inherit credentials, refresh commands, controller or live HQ paths.
    PATH: `${fakeBin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: dir, TMPDIR: run, TMP: run, TEMP: run,
    ADVERSARIAL_REVIEW_TEST_SANDBOX_ROOT: dir,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GIT_TERMINAL_PROMPT: '0',
    HAM_NODE_BIN: process.execPath, HAM_ROOT_DIR: dir, HAM_HQ_ROOT: dir, HQ_ROOT: dir,
    AGENT_OS_HQ_ROOT: dir, AGENT_OS_CONFIG_PATH: join(dir, 'root-config.yaml'),
    HAM_REPO: 'fixture/repo', HAM_PR_NUMBER: '42', HAM_RUN_DIR: run,
    HQ_LAUNCH_REQUEST_ID: 'lrq_contract', AGENT_OS_WORKER_LRQ_ID: 'lrq_contract',
    HQ_WORKER_RUN_ID: 'wrun_contract', BASE_BRANCH: 'main',
    HAM_PROCEDURE_STEP: 'synthetic-contract', HAM_CONFLICT_PROOF_REASON: 'conflict-primary-unproven',
    GHO_RATE_LIMIT_SHARED_STATE_PATH: join(run, 'budget.json'),
    // Guarded CLIs compare import.meta.url with argv[1]. Keep their fixture
    // entrypoint path intact so the real main executes through bin/ symlinks.
    NODE_OPTIONS: `--preserve-symlinks-main --import=${preload}`,
    // Preserve external netguard evidence when this test is invoked by a worker.
    ...(process.env.NETGUARD_LOG ? { NETGUARD_LOG: process.env.NETGUARD_LOG } : {}),
  };
  const git = (...args) => execFileSync('git', args, {
    cwd: checkout, env, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
  }).trimEnd();
  git('init', '-q', '-b', 'main');
  writeFileSync(join(checkout, 'example.txt'), 'base\n');
  git('add', 'example.txt'); git('commit', '-qm', 'Synthetic base');
  git('checkout', '-qb', 'author');
  writeFileSync(join(checkout, 'example.txt'), 'author\n');
  git('commit', '-qam', 'Synthetic author correction');
  const reviewed = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'main');
  writeFileSync(join(checkout, 'upstream.txt'), 'upstream\n');
  git('add', 'upstream.txt'); git('commit', '-qm', 'Synthetic upstream');
  const base = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'author'); git('rebase', 'main');
  const head = git('rev-parse', 'HEAD');
  const review = { id: 1, node_id: 'PRR_synthetic', commit_id: reviewed, state: 'CHANGES_REQUESTED',
    submitted_at: '2026-01-01T00:00:00Z', user: { login: amaAllAuthoritativeReviewerLogins()[0] },
    body: '## Adversarial Review\n## Blocking issues\n- **Synthetic correction**\n'
      + '  - **File:** `src/example.mjs`\n  - **Lines:** 2\n  - **Problem:** Synthetic correction.\n'
      + '## Non-blocking issues\n- **Synthetic simplification**\n  - **File:** `src/example.mjs`\n'
      + '  - **Lines:** 2\n  - **Problem:** Synthetic simplification.\n## Verdict\nRequest changes\n' };
  writeFileSync(join(run, 'fixture.json'), JSON.stringify({ head, reviewed, base, review }));
  writeFileSync(join(run, 'review.md'), review.body);
  writeFileSync(join(run, 'evidence.md'), `\`\`\`head-file ${head}:src/example.mjs\nnew\n\`\`\`\n`);
  const fakeGh = `${shellQuote(process.execPath)} ${shellQuote(join(root, 'test/fixtures/hammer-prompt-gh.mjs'))}`;
  mkdirSync(join(run, 'gh-cache'));
  // Cache only this deterministic transport, never a helper's parsing/result.
  // cksum selects a bucket; exact NUL-delimited argv comparison makes hash
  // collisions misses. Atomic mkdir grants one writer; ready is published last.
  writeFileSync(join(fakeBin, 'gh'), `#!/bin/bash
unset NODE_OPTIONS
export HAM_RUN_DIR=${shellQuote(run)}
fixture_key=$(printf '%s\\0' "$@" | cksum)
fixture_bucket="$HAM_RUN_DIR/gh-cache/\${fixture_key// /-}"
if [ -f "$fixture_bucket/ready" ] && cmp -s "$fixture_bucket/argv" <(printf '%s\\0' "$@"); then
  cat "$fixture_bucket/stdout"
  exit 0
fi
if mkdir "$fixture_bucket" 2>/dev/null; then
  printf '%s\\0' "$@" > "$fixture_bucket/argv"
  ${fakeGh} "$@" > "$fixture_bucket/stdout"
  fixture_status=$?
  if [ "$fixture_status" -eq 0 ]; then : > "$fixture_bucket/ready"; fi
  cat "$fixture_bucket/stdout"
  exit "$fixture_status"
fi
exec ${fakeGh} "$@"
`, { mode: 0o755 });
  // The validator's real pytest argv/environment setup runs, but no Python
  // installation or test runner is required for this argument conformance test.
  writeFileSync(join(fakeBin, 'python3'), `#!/bin/sh\nunset NODE_OPTIONS\nexec ${shellQuote(process.execPath)} ${shellQuote(join(root, 'test/fixtures/hammer-prompt-python.mjs'))} "$@"\n`, { mode: 0o755 });
  const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8', timeout: 2000 }).trim();
  writeFileSync(join(fakeBin, 'git'), `#!/bin/sh
for arg do
  case "$arg" in
    clone|fetch|pull|push|ls-remote|*://*|*@*:*) echo "fixture refuses remote Git" >&2; exit 98 ;;
  esac
done
exec ${shellQuote(realGit)} "$@"
`, { mode: 0o755 });
  // No remote Git operation can escape this disposable checkout.
  writeFileSync(join(fakeBin, 'ssh'), '#!/bin/sh\nexit 98\n', { mode: 0o755 });
  const db = openReviewStateDb(dir);
  ensureReviewStateSchema(db); db.close();
  const launchDir = join(dir, 'dispatch/lrq_contract');
  mkdirSync(launchDir, { recursive: true });
  writeFileSync(join(launchDir, 'env-contract.json'), JSON.stringify({
    launchProvenance: { launchRequestId: 'lrq_contract', workerClass: 'hammer' },
    ADVERSARIAL_DISPATCH_READS_ENABLED: '1',
  }));
  writeFileSync(join(run, 'close-controller.sh'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  Object.assign(env, {
    HAM_BASE_HEAD: reviewed, HAM_REVIEWED_SHA: reviewed, HAM_TARGET_REMEDIATION_SHA: head,
    POST_REMEDIATION_SHA: head, HAM_CONFLICT_SOURCE: reviewed, HAM_CONFLICT_BASE: base,
    DISPUTED_HEAD: head, HAM_DISPUTE_EVIDENCE_FILE: join(run, 'evidence.md'),
    HAM_PRIMARY_CHANGE_FILE: join(run, 'primary-change.json'),
    HAM_AUDIT_COMMENT_BODY: `HAM-Validated-Head: ${head}`,
  });
  const values = {
    ROOT_DIR: dir, RUN_DIR: run, HQ_ROOT: dir, REPO: 'fixture/repo', PR_NUMBER: '42',
    PR_URL: 'https://github.com/fixture/repo/pull/42', REVIEWED_SHA: reviewed,
    TARGET_REMEDIATION_SHA: head, HQ_OWNER: 'synthetic-owner', REVIEWER: 'codex',
    RISK_CLASS: 'low', MERGE_METHOD: 'squash', AUDIT_PATH: join(run, 'audit.json'),
    AMA_TRAILERS_SHELL: "''", STRICT_NON_BLOCKING_REMEDIATION: 'true',
  };
  const metavariables = {
    'numeric-review-id': '1', 'plan.json': join(run, 'plan.json'),
    'complete-final-review-file': join(run, 'review.md'), 'printed-reason': 'synthetic-refusal',
    'reason-code': 'synthetic-refusal', 'review node id or URL': 'PRR_synthetic', n: '1',
  };
  const render = text => text.replace(/<<([A-Z_]+)>>/g, (_, key) => {
    assert.ok(Object.hasOwn(values, key), `unbound template value: ${key}`);
    return values[key];
  }).replace(/<([^<>]+)>/g, (_, key) => {
    assert.ok(Object.hasOwn(metavariables, key), `unbound argument example: ${key}`);
    return metavariables[key];
  });
  const definitions = template.match(/^ham_(?:step|read)\(\).*$/gm).map(render).join('\n');
  const execute = (command, overrides = {}) => new Promise(resolve => {
    if (t.signal.aborted) {
      resolve({ status: null, error: Error('conformance test ended'), stdout: '', stderr: '' });
      return;
    }
    const child = spawn('/bin/bash', ['-ec',
      `source ${shellQuote(join(dir, 'bin/hammer-shell-helpers.sh'))}\n${definitions}\nHAM_DISPUTE_RUN=()\n${command}`], {
      cwd: checkout, env: { ...env, ...overrides }, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.add(child);
    let stdout = '', stderr = '', error, hardKill;
    const timeout = setTimeout(() => {
      error = Error('documented command exceeded 10 seconds');
      killGroup(child, 'SIGTERM');
      hardKill = setTimeout(() => killGroup(child), 500);
    }, 10_000);
    child.stdout.setEncoding('utf8').on('data', data => { stdout += data; });
    child.stderr.setEncoding('utf8').on('data', data => { stderr += data; });
    child.on('error', cause => { error = cause; });
    child.on('close', status => {
      clearTimeout(timeout); clearTimeout(hardKill);
      killGroup(child); children.delete(child);
      resolve({ status, error, stdout, stderr });
    });
  });
  return { dir, run, head, reviewed, base, env, render, execute };
}

test('command timeout reaps descendants holding pipes after the group leader exits', async t => {
  const f = fixture(t);
  const source = "process.on('SIGTERM', () => {}); console.log('descendant ready'); setInterval(() => {}, 1000);";
  const result = await f.execute(`${shellQuote(process.execPath)} -e ${shellQuote(source)} &\nexit 0`);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /descendant ready/);
  assert.match(result.error?.message ?? '', /documented command exceeded 10 seconds/);
});

test('offline transport fixtures handle blob queries and reject unknown projections', async t => {
  const f = fixture(t);
  const blob = await f.execute('git rev-parse HEAD:example.txt');
  assert.equal(blob.status, 0, blob.stderr);
  for (const query of ['', '?encoding=base64']) {
    const result = await f.execute(`gh api repos/fixture/repo/git/blobs/${blob.stdout.trim()}${query}`);
    assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(result.stdout);
    assert.equal(value.encoding, 'base64');
    assert.equal(Buffer.from(value.content, 'base64').toString(), 'author\n');
    assert.equal(value.size, Buffer.byteLength('author\n'));
  }
  const endpoint = `repos/fixture/repo/commits/${f.head}`;
  const supported = await f.execute(`gh api ${endpoint} --jq '{sha, verification: .commit.verification}'`);
  assert.equal(supported.status, 0, supported.stderr);
  assert.deepEqual(JSON.parse(supported.stdout), {
    sha: f.head, verification: { verified: true, reason: 'valid' },
  });
  const unknown = await f.execute(`gh api ${endpoint} --jq '{unsupported: .sha}'`);
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /unhandled fixture jq: \{unsupported: \.sha\}/);
  assert.equal(unknown.stdout, '');
  const controller = await f.execute(shellQuote(join(f.run, 'close-controller.sh')));
  assert.equal(controller.status, 0, controller.stderr);
});

test('fixture sleeps advance synchronously and support Promise chaining', t => {
  const f = fixture(t);
  for (const [entrypoint, module, symbol] of [
    ['hammer-context', 'closure-gate-read', 'closureGateClock'],
    ['hammer-conflict-primary', 'hammer-api-network', 'hammerNetworkClock'],
    ['hammer-controller', 'hammer-controller', 'launchEnvironmentClock'],
  ]) {
    const source = `
      import assert from 'node:assert/strict';
      process.argv[1] = ${JSON.stringify(`/synthetic/${entrypoint}.mjs`)};
      await import(${JSON.stringify(preload)});
      const { ${symbol}: clock } = await import(${JSON.stringify(join(root, `src/ama/${module}.mjs`))});
      assert.equal(clock.now(), 0);
      const pending = clock.sleep(25);
      assert.equal(clock.now(), 25);
      await pending.then(() => assert.equal(clock.now(), 25));
    `;
    execFileSync(process.execPath, ['--input-type=module', '-e', source], {
      cwd: f.dir, env: { ...f.env, NODE_OPTIONS: '' }, timeout: 5000, stdio: 'pipe',
    });
  }
});

test('every concrete hammer prompt helper call executes against the real helper offline', { timeout: 30_000 }, async t => {
  const f = fixture(t);
  const { commands, json } = documentedExamples(template);
  assert.ok(commands.length > 20, 'the prompt reader must find fenced and inline examples');
  // The prompt now delegates complete plan examples to the helper's --help.
  const usage = await f.execute('"$HAM_NODE_BIN" "$HAM_ROOT_DIR/bin/hammer-edit-plan.mjs" --help');
  assert.equal(usage.error, undefined, usage.stderr);
  assert.equal(usage.status, 0, usage.stderr);
  const plans = documentedExamples(usage.stdout).json.filter(({ value }) => value.editKind);
  assert.ok(plans.length >= 4);
  for (const { value } of json) {
    if (value.editKind || value.reviewedHead) continue;
    if (value.active === true && value.commit && value.auditComment) {
      // The claim is a schema example; resolve its literal explanatory values
      // without manufacturing or removing any fields.
      const claimValues = {
        'validated-post-remediation-sha': f.head, REVIEWED_SHA: f.reviewed,
        n: '1', b: '1', nb: '0', 'posted PR audit comment body': `HAM-Validated-Head: ${f.head}`,
        'every path from the verified commit files[]': 'src/example.mjs',
        'doc paths changed in this commit, when status is updated': 'docs/example.md',
        'owed superproject docs, when status is skipped_superproject': 'docs/superproject.md',
        'finding title': 'Synthetic correction', path: 'src/example.mjs',
      };
      const claim = JSON.parse(JSON.stringify(value)
        .replace(/<<([A-Z_]+)>>|<([^<>]+)>/g, (_, templateKey, literalKey) => {
          const key = templateKey || literalKey;
          assert.ok(Object.hasOwn(claimValues, key), `unbound claim example: ${key}`);
          return claimValues[key];
        }).replaceAll('updated | skipped_superproject | not_applicable', 'updated'));
      writeFileSync(join(f.run, 'terminal-remediation.json'), JSON.stringify(claim));
    } else if (value.base && value.ours && value.theirs && value.resolved) {
      assert.deepEqual(value.resolved, { ...value.base, ...value.ours, ...value.theirs });
    } else assert.fail(`unbound JSON example: ${JSON.stringify(value)}`);
  }
  // The real readers in the documented sequence produce the predicate inputs.
  writeFileSync(join(f.run, 'range.json'), JSON.stringify({ base: f.reviewed, head: f.head }));
  const seen = new Set();
  const executed = new Set();
  const tasks = [];
  const running = new Set();
  const runTask = async check => {
    while (running.size >= 4) await Promise.race(running);
    if (t.signal.aborted) return { status: 'rejected', reason: Error('conformance test ended') };
    const task = check().then(() => ({ status: 'fulfilled' }), reason => ({ status: 'rejected', reason }));
    running.add(task);
    try { return await task; } finally { running.delete(task); }
  };
  const predicates = [];
  // Four independent examples at a time. The predicate waits for every input
  // producer. Terminal examples get separate audit roots; all plans have their
  // own file. The real primary-change store serializes immutable cache writes.
  for (const { command, line } of commands) {
    assertExternalCommands(command, functions);
    const names = [...command.matchAll(/bin\/([\w-]+\.(?:mjs|sh))/g)].map(m => m[1]);
    const known = new Set(['hammer-node-runtime.sh', 'hammer-shell-helpers.sh', 'hammer-terminal-audit.mjs',
      'hammer-lease-state.mjs', 'hammer-validate.mjs', 'hammer-context.mjs', 'hammer-helper-step.mjs',
      'hammer-base-head.mjs', 'hammer-controller.mjs', 'guard-forbidden-paths.mjs', 'hammer-edit-plan.mjs',
      'dispute-finding.mjs', 'stacked-base-check.mjs', 'hammer-pr-read.mjs', 'hammer-progress.mjs',
      'hammer-conflict-primary.mjs', 'hammer-predicate-inputs.mjs', 'hammer-claim-head.mjs',
      'primary-change-context.mjs', 'ama-check.mjs']);
    for (const name of names) {
      assert.ok(known.has(name), `add a real-helper fixture for ${name} at prompt line ${line}`);
      seen.add(name);
    }
    // Repeated identical examples share one execution; each occurrence still
    // passes discovery, binding and shell-function checks.
    const rendered = f.render(command);
    if (executed.has(rendered)) continue;
    executed.add(rendered);
    const editPlan = names.includes('hammer-edit-plan.mjs') && !/\s--help$/.test(rendered);
    const variants = editPlan ? plans : [null];
    for (const [index, plan] of variants.entries()) {
      let invocation = rendered;
      if (plan) {
        const planPath = join(f.run, `plan-${line}-${index}.json`);
        writeFileSync(planPath, JSON.stringify(plan.value).replaceAll('a'.repeat(40), f.reviewed));
        invocation = invocation.replace(join(f.run, 'plan.json'), planPath);
      }
      const overrides = names.includes('hammer-progress.mjs') ? { HAM_TARGET_REMEDIATION_SHA: f.base } : {};
      if (names.includes('hammer-terminal-audit.mjs')) {
        const terminalRoot = join(f.dir, `terminal-${tasks.length}`);
        mkdirSync(terminalRoot);
        Object.assign(overrides, { HAM_HQ_ROOT: terminalRoot, HAM_RUN_DIR: terminalRoot });
      }
      const check = async () => {
        // The progress example is documented after a new descendant commit;
        // conflict proof uses the separate reviewed-head replay fixture.
        const result = await f.execute(invocation, overrides);
        const detail = `prompt line ${line}: ${command}\n${result.stderr}\n${result.stdout}`;
        assert.equal(result.error, undefined, detail);
        assert.doesNotMatch(result.stderr, /usage:|ENOENT|command not found|unknown (?:argument|option)/i, detail);
        assert.doesNotMatch(result.stdout, /"(?:reason|reasonCode)"\s*:\s*"[^"]*-invalid"/, detail);
        assert.equal(result.status, 0, detail);
        if (editPlan) assert.equal(JSON.parse(result.stdout).action, 'allow', detail);
        if (names.includes('hammer-lease-state.mjs')) assert.equal(result.stdout.trim(), 'none', detail);
        if (names.includes('ama-check.mjs')) assert.equal(typeof JSON.parse(result.stdout).eligible, 'boolean', detail);
        if (names.includes('hammer-conflict-primary.mjs')) {
          assert.equal(JSON.parse(result.stdout).proof, 'conflict-primary-preserved', detail);
        }
        if (names.includes('primary-change-context.mjs')) writeFileSync(f.env.HAM_PRIMARY_CHANGE_FILE, result.stdout);
      };
      if (names.includes('ama-check.mjs')) predicates.push(check);
      else tasks.push(runTask(check));
    }
  }
  const results = await Promise.all(tasks);
  for (const result of results) if (result.status === 'rejected') throw result.reason;
  for (const check of predicates) await check();
  assert.ok(seen.has('hammer-edit-plan.mjs') && seen.has('ama-check.mjs'));
  t.diagnostic(`${commands.length} documented commands (${executed.size} distinct) and ${json.length} literal JSON examples exercised`);
});

test('argv-exec wrappers reject documented shell function commands, including quoted names', () => {
  for (const command of [
    'ham_read review-read ham_gh api repos/fixture/repo/pulls/42',
    'ham_read review-read "ham_gh" api repos/fixture/repo/pulls/42',
    'ham_step read:report review-read 90 540 ham_pr --json reviews',
    'node /synthetic/bin/hammer-helper-step.mjs read:report review-read 90 540 ham_gh api fixture',
    '/usr/bin/perl -e \'alarm shift; exec @ARGV\' 90 ham_gh api fixture',
  ]) assert.throws(() => assertExternalCommands(command, functions), /cannot execute shell function/);
});

test('example discovery retains flags, multiline argv, JSON, and inline commands', () => {
  const markdown = [
    '```bash',
    'ham_read review-read "$HAM_NODE_BIN" "<<ROOT_DIR>>/bin/hammer-pr-read.mjs" \\',
    '  fixture/repo 42 --undocumented-flag > "$OUTPUT" || exit 1',
    '```',
    '`node <<ROOT_DIR>>/bin/hammer-edit-plan.mjs --help`',
    '```json',
    '{"reviewedHead":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","editKind":"invalid"}',
    '```',
  ].join('\n');
  const examples = documentedExamples(markdown);
  assert.equal(examples.commands.length, 2);
  assert.equal(examples.commands[0].line, 2);
  assert.match(examples.commands[0].command, /42 --undocumented-flag$/);
  assert.match(examples.commands[1].command, /hammer-edit-plan\.mjs --help$/);
  assert.equal(examples.json[0].value.editKind, 'invalid');
  assert.throws(() => documentedExamples('```bash\nunknown-runner <<ROOT_DIR>>/bin/new-helper.mjs\n```'),
    /unhandled executable example/);
});
