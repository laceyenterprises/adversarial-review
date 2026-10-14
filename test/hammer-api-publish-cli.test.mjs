import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchHammerPr } from '../src/hammer-pr-read.mjs';
import { fetchPrimaryChange } from '../src/ama/primary-change.mjs';
import { normalizeVerifiedCloserCommit } from '../src/head-closer-commit-suppression.mjs';
import { buildHamTerminalRemediationEvidenceFromGroundTruth } from '../src/ama/dispatch-closer.mjs';
import { amaAuthoritativeReviewerLoginsForModel } from '../src/ama/reviewer-authority.mjs';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/hammer-api-publish.mjs', import.meta.url));
const repoRoot = fileURLToPath(new URL('../', import.meta.url));

function fixture(t, scenario, target = 'pr') {
  const root = mkdtempSync(join(tmpdir(), 'hammer-api-publish-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const callsFile = join(root, 'calls.json');
  writeFileSync(callsFile, '[]');
  for (const command of ['gh', 'git']) {
    writeFileSync(join(root, command), `#!${process.execPath}
import { readFileSync, writeFileSync } from 'node:fs';
const command = ${JSON.stringify(command)};
const scenario = ${JSON.stringify(scenario)};
const target = ${JSON.stringify(target)};
const callsFile = ${JSON.stringify(callsFile)};
const args = process.argv.slice(2);
const input = args.includes('--input') ? JSON.parse(readFileSync(0, 'utf8')) : undefined;
const key = command === 'gh' ? (args[0] === 'pr' || args[1]?.endsWith('/pulls/1') ? 'pr' : args[1] === 'graphql' ? 'mutation' : 'verification')
  : args[0] === 'fetch' ? 'fetch-' + args[2] : args[0];
const calls = JSON.parse(readFileSync(callsFile, 'utf8'));
const attempt = calls.filter(call => call.key === key).length + 1;
calls.push({ key, args, input });
writeFileSync(callsFile, JSON.stringify(calls));
const fail = message => { process.stderr.write(message); process.exit(1); };
if (scenario === 'recover' && ['pr', 'mutation', 'verification', 'fetch-before', 'fetch-published'].includes(key) && attempt === 1)
  fail(command === 'git' ? 'fatal: early EOF' : 'TLS handshake timeout');
if (key === target) {
  if (scenario === 'exhaust') fail('HTTP 503 Service Unavailable');
  if (scenario === 'permanent') fail(command === 'git' ? 'fatal: Authentication failed' : 'HTTP 403 Forbidden');
  if (scenario === 'ambiguous' && attempt === 1) fail('TLS handshake timeout');
  if (scenario === 'ambiguous') fail('HTTP 422 expected head does not match');
  if (scenario === 'malformed') { process.stdout.write('{'); process.exit(0); }
}
if (command === 'gh') {
  if (key === 'pr') process.stdout.write(JSON.stringify({ head: { ref: 'worker', sha: 'before' } }));
  else if (key === 'mutation') process.stdout.write(JSON.stringify({ data: { createCommitOnBranch: { commit: { oid: 'published' } } } }));
  else if (key === 'verification') process.stdout.write(JSON.stringify({ commit: { tree: { sha: 'tree' } } }));
  else fail('unexpected gh call');
} else {
  if (key === 'merge-base') process.exit(scenario === 'rebased' ? 1 : 0);
  if (key === 'rev-list') { process.stdout.write(args.includes('--count') ? (scenario === 'multiple' ? '2' : '1') : (scenario === 'merge' ? 'local before other' : 'local before')); process.exit(0); }
  if (key === 'status' || key.startsWith('fetch-') || key === 'reset') process.exit(0);
  if (key === 'ls-tree') process.stdout.write('100644 blob ' + (args[2] === 'HEAD' ? 'new' : 'old') + '\\tfile\\0');
  else if (key === 'cat-file') process.stdout.write('a');
  else if (key === 'rev-parse') process.stdout.write('tree\\n');
  else if (key === 'log') process.stdout.write('HAM\\ntrailers\\n');
  else fail('unexpected git call');
}
`, { mode: 0o755 });
  }
  return {
    run: async () => JSON.parse((await exec(process.execPath, [cli, 'fixture/repo', '1'], {
      env: { ...process.env, PATH: `${root}:${process.env.PATH}` }, timeout: 20000,
    })).stdout),
    calls: () => JSON.parse(readFileSync(callsFile, 'utf8')),
  };
}

test('API publisher retries every network subprocess and preserves mutation CAS and contents', async t => {
  const f = fixture(t, 'recover');
  assert.deepEqual(await f.run(), { route: 'published', head: 'published', tree: 'tree', previousHead: 'before' });
  for (const key of ['pr', 'mutation', 'verification', 'fetch-before', 'fetch-published']) {
    assert.equal(f.calls().filter(call => call.key === key).length, 2, key);
  }
  const mutations = f.calls().filter(call => call.key === 'mutation');
  assert.deepEqual(mutations[0].input, mutations[1].input);
  assert.equal(mutations[0].input.variables.input.expectedHeadOid, 'before');
  assert.deepEqual(mutations[0].input.variables.input.fileChanges.additions, [{ path: 'file', contents: 'YQ==' }]);
  assert.equal(f.calls().at(-1).key, 'reset');
});

for (const target of ['pr', 'mutation', 'verification', 'fetch-before', 'fetch-published']) {
  for (const [scenario, attempts] of [['exhaust', 3], ['permanent', 1]]) {
    test(`API publisher ${target} fails closed after ${scenario}`, async t => {
      const f = fixture(t, scenario, target);
      const result = await f.run();
      assert.equal(result.route, 're-review');
      assert.equal(f.calls().filter(call => call.key === target).length, attempts);
      assert.ok(!f.calls().some(call => call.key === 'reset'));
      if (target !== 'pr') assert.equal(result.fallbackHead,
        ['verification', 'fetch-published'].includes(target) ? 'published' : 'before');
    });
  }
}

test('an ambiguous mutation retains the original CAS and rejects unsafe publication', async t => {
  const f = fixture(t, 'ambiguous', 'mutation');
  const result = await f.run();
  assert.equal(result.route, 're-review');
  assert.equal(result.fallbackHead, 'before');
  const mutations = f.calls().filter(call => call.key === 'mutation');
  assert.equal(mutations.length, 2);
  assert.deepEqual(mutations[0].input, mutations[1].input);
  assert.ok(!f.calls().some(call => call.key === 'reset'));
});

test('malformed successful responses fall back without transport retries', async t => {
  const f = fixture(t, 'malformed');
  assert.equal((await f.run()).route, 're-review');
  assert.equal(f.calls().filter(call => call.key === 'pr').length, 1);
});

for (const scenario of ['rebased', 'multiple', 'merge']) {
  test(`API publisher refuses ${scenario} history before mutation or reset`, async t => {
    const f = fixture(t, scenario);
    const result = await f.run();
    assert.equal(result.route, 're-review');
    assert.equal(result.fallbackHead, 'before');
    assert.equal(result.branch, 'worker');
    assert.ok(!f.calls().some(call => ['mutation', 'reset'].includes(call.key)));
  });
}

test('a real rebase onto a moved base retains local ancestry and refuses the API route', async t => {
  const root = mkdtempSync(join(tmpdir(), 'hammer-rebased-history-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const work = join(root, 'work'), remote = join(root, 'remote.git'), bin = join(root, 'bin');
  mkdirSync(work); mkdirSync(bin);
  const git = (...args) => exec('git', args, { cwd: work, timeout: 10000 });
  await git('init', '--bare', remote);
  await git('init', '-b', 'main');
  await git('config', 'user.name', 'Fixture');
  await git('config', 'user.email', 'fixture@example.invalid');
  await git('remote', 'add', 'origin', remote);
  writeFileSync(join(work, 'base'), 'old base\n');
  await git('add', '.'); await git('commit', '-m', 'base');
  await git('checkout', '-b', 'worker');
  writeFileSync(join(work, 'feature'), 'remediation\n');
  await git('add', '.'); await git('commit', '-m', 'HAM remediation');
  await git('push', 'origin', 'worker');
  const remoteHead = (await git('rev-parse', 'HEAD')).stdout.trim();
  await git('checkout', 'main');
  writeFileSync(join(work, 'base'), 'moved base\n');
  await git('add', '.'); await git('commit', '-m', 'move base');
  const baseHead = (await git('rev-parse', 'HEAD')).stdout.trim();
  await git('checkout', 'worker'); await git('rebase', 'main');
  const localHead = (await git('rev-parse', 'HEAD')).stdout.trim();
  const callsFile = join(root, 'gh-calls');
  writeFileSync(join(bin, 'gh'), `#!${process.execPath}
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(callsFile)}, process.argv.slice(2).join(' ') + '\\n');
if (process.argv[2] !== 'api' || !process.argv[3].endsWith('/pulls/1')) process.exit(1);
console.log(JSON.stringify({ head: { ref: 'worker', sha: ${JSON.stringify(remoteHead)} } }));
`, { mode: 0o755 });
  const result = JSON.parse((await exec(process.execPath, [cli, 'fixture/repo', '1'], {
    cwd: work, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, timeout: 20000,
  })).stdout);
  assert.equal(result.route, 're-review');
  assert.match(result.reason, /does not descend/);
  assert.equal(result.fallbackHead, remoteHead);
  assert.equal(readFileSync(callsFile, 'utf8'), 'api repos/fixture/repo/pulls/1\n');
  assert.equal((await git('rev-parse', 'HEAD')).stdout.trim(), localHead);
  await git('merge-base', '--is-ancestor', baseHead, 'HEAD');
  assert.equal((await git('ls-remote', 'origin', 'refs/heads/worker')).stdout.split(/\s/)[0], remoteHead);
});

for (const route of ['api', 'git-explicit', 'git-tracking']) {
  test(`HAMPREDICATE-01: ${route} publication and rendered audit pass the whole CLI predicate`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'hammer-predicate-e2e-'));
    const pr = String(2_000_000 + process.pid);
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const work = join(root, 'work'), remote = join(root, 'remote.git'), bin = join(root, 'bin');
    mkdirSync(work); mkdirSync(bin);
    const git = async (...args) => (await exec('git', args, { cwd: work, timeout: 10000 })).stdout.trim();
    await git('init', '--bare', remote);
    await git('init', '-b', 'main');
    await git('config', 'user.name', 'Synthetic hammer');
    await git('config', 'user.email', 'hammer@example.invalid');
    await git('config', 'commit.gpgsign', 'false');
    await git('remote', 'add', 'origin', remote);
    mkdirSync(join(work, 'src'));
    const filename = 'src/feature.mjs';
    writeFileSync(join(work, filename), 'base();\n');
    await git('add', filename); await git('commit', '-m', 'Synthetic base');
    const base = await git('rev-parse', 'HEAD');
    await git('push', 'origin', 'main');
    await git('checkout', '-b', 'worker');
    writeFileSync(join(work, filename), 'feature();\n');
    await git('add', filename); await git('commit', '-m', 'Synthetic builder change');
    await git('push', '-u', 'origin', 'worker');
    const reviewed = await git('rev-parse', 'HEAD');
    writeFileSync(join(work, filename), 'feature_safe();\n');
    await git('add', filename);
    await git('commit', '-m', `Synthetic repair\n\nWorker-Class: hammer\nWorker-Ticket: HAM\nReviewed-Head: ${reviewed}\nClosed-By: hammer (adversarial-pipe-mode)\nRemediated-Findings: 1 addressed (1 blocking, 0 non-blocking)`);
    const local = await git('rev-parse', 'HEAD');
    const localTree = await git('rev-parse', 'HEAD^{tree}');
    const commentsPath = join(root, 'comments.json');
    const callsPath = join(root, 'calls.json');
    writeFileSync(commentsPath, '[]'); writeFileSync(callsPath, '[]');
    // A local fake hosting service reconstructs the API tree from the actual
    // mutation payload. Every git operation uses the temporary local remote.
    writeFileSync(join(bin, 'gh'), `#!${process.execPath}
const fs = require('node:fs'), cp = require('node:child_process');
const work = ${JSON.stringify(work)}, remote = ${JSON.stringify(remote)}, base = ${JSON.stringify(base)};
const commentsPath = ${JSON.stringify(commentsPath)}, callsPath = ${JSON.stringify(callsPath)};
const args = process.argv.slice(2), route = ${JSON.stringify(route)};
const calls = JSON.parse(fs.readFileSync(callsPath)); calls.push(args); fs.writeFileSync(callsPath, JSON.stringify(calls));
const git = (args, options = {}) => cp.execFileSync('git', args, { cwd: work, timeout: 10000, ...options }).toString().trim();
const head = () => git(['--git-dir', remote, 'rev-parse', 'refs/heads/worker']);
const output = value => console.log(JSON.stringify(value));
const fail = message => { console.error(message); process.exit(1); };
const commit = sha => {
  const web = git(['show', '-s', '--format=%cn', sha]) === 'Synthetic web-flow';
  const patch = git(['diff', sha + '^', sha, '--', '${filename}']).replace(/^[\\s\\S]*?(?=@@)/, '');
  const stats = git(['diff', '--numstat', sha + '^', sha, '--', '${filename}']).split(/\\s+/);
  return { sha, author: { login: sha === base || sha === ${JSON.stringify(reviewed)} ? 'synthetic-builder' : 'hammer-worker' },
    committer: { login: web ? 'web-flow' : 'hammer-worker' }, parents: [{ sha: git(['rev-parse', sha + '^']) }],
    commit: { message: git(['log', '-1', '--format=%B', sha]), tree: { sha: git(['rev-parse', sha + '^{tree}']) },
      verification: { verified: web, reason: web ? 'valid' : 'unsigned' } },
    files: [{ filename: '${filename}', status: 'modified', additions: Number(stats[0]), deletions: Number(stats[1]), patch }] };
};
if (args[0] === 'pr' && args[1] === 'comment') {
  const comments = JSON.parse(fs.readFileSync(commentsPath));
  comments.push({ id: 1, user: { login: 'hammer-worker' }, body: args[args.indexOf('--body') + 1] });
  fs.writeFileSync(commentsPath, JSON.stringify(comments)); output({ id: 1 });
} else if (args[0] !== 'api') fail('unexpected fake service command');
else if (args[1] === 'graphql') {
  if (route !== 'api') fail('HTTP 422 unsupported API publication');
  const input = JSON.parse(fs.readFileSync(0, 'utf8')).variables.input;
  if (input.expectedHeadOid !== head()) fail('HTTP 422 CAS mismatch');
  const env = { ...process.env, GIT_INDEX_FILE: ${JSON.stringify(join(root, 'service.index'))},
    GIT_AUTHOR_NAME: 'Synthetic hammer', GIT_AUTHOR_EMAIL: 'hammer@example.invalid',
    GIT_COMMITTER_NAME: 'Synthetic web-flow', GIT_COMMITTER_EMAIL: 'hosting@example.invalid' };
  git(['read-tree', input.expectedHeadOid], { env });
  for (const file of input.fileChanges.additions) {
    const blob = git(['hash-object', '-w', '--stdin'], { input: Buffer.from(file.contents, 'base64'), env });
    git(['update-index', '--add', '--cacheinfo', '100644', blob, file.path], { env });
  }
  for (const file of input.fileChanges.deletions) git(['update-index', '--force-remove', file.path], { env });
  const tree = git(['write-tree'], { env });
  const sha = git(['commit-tree', tree, '-p', input.expectedHeadOid], {
    env, input: input.message.headline + '\\n' + input.message.body + '\\n' });
  git(['--git-dir', remote, 'fetch', work, sha]);
  git(['--git-dir', remote, 'update-ref', 'refs/heads/worker', sha, input.expectedHeadOid]);
  output({ data: { createCommitOnBranch: { commit: { oid: sha } } } });
} else {
  const path = args.find(arg => arg.startsWith('repos/'));
  if (!path) fail('unexpected fake service API');
  if (path.endsWith('/pulls/${pr}')) {
    if (route === 'git-tracking' && process.env.HAM_COMMIT_PUBLICATION_ONLY === '1') fail('HTTP 403 synthetic PR read unavailable');
    output({ number: ${pr}, head: { ref: 'worker', sha: head() }, base: { ref: 'main', sha: base },
      state: 'open', draft: false, mergeable: true, mergeable_state: 'clean', labels: [], user: { login: 'synthetic-builder' } });
  } else if (path.includes('/check-runs?')) output({ check_runs: [
    { name: 'test', status: 'completed', conclusion: 'success' },
    { name: 'agent-os/adversarial-gate', status: 'completed', conclusion: 'success' } ] });
  else if (path.includes('/statuses?')) output([]);
  else if (path.includes('/comments')) {
    const comments = JSON.parse(fs.readFileSync(commentsPath)); output(args.includes('--slurp') ? [comments] : comments);
  } else if (path.includes('/compare/')) {
    const [from, to] = path.split('/compare/')[1].split('...');
    const patch = git(['diff', from, to, '--', '${filename}']).replace(/^[\\s\\S]*?(?=@@)/, '');
    const stats = git(['diff', '--numstat', from, to, '--', '${filename}']).split(/\\s+/);
    const shas = git(['rev-list', '--reverse', from + '..' + to]).split('\\n').filter(Boolean);
    output({ status: 'ahead', total_commits: shas.length, commits: shas.map(commit), merge_base_commit: { sha: base },
      files: patch ? [{ filename: '${filename}', status: 'modified', additions: Number(stats[0]), deletions: Number(stats[1]), patch }] : [] });
  } else if (path.includes('/commits/')) output(commit(path.split('/commits/')[1]));
  else fail('unrecorded fake service API ' + path);
}
`, { mode: 0o755 });
    const config = join(root, 'global.yaml');
    writeFileSync(config, 'version: 1\nroles:\n  adversarial:\n    merge_authority:\n      enabled: true\n      eligibility:\n        risk_classes: [low]\n      branch_protection:\n        required: true\n');
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: root,
      AGENT_OS_CONFIG_PATH: config, GHO_RATE_LIMIT_SHARED_STATE_PATH: join(root, 'budget.json'),
      GH_TOKEN: 'synthetic-token', HAMMER_LACEY_GH_TOKEN: 'synthetic-token',
      HAM_ROOT_DIR: repoRoot, HAM_NODE_BIN: process.execPath, HAM_REPO: 'fixture/repo', HAM_PR_NUMBER: pr,
      HAM_PR_URL: `https://github.com/fixture/repo/pull/${pr}`, HAM_REVIEWED_SHA: reviewed, HAM_BASE_HEAD: reviewed,
      HAM_AUDIT_REMEDIATED_TOTAL: '1', HAM_AUDIT_REMEDIATED_BLOCKING: '1', HAM_AUDIT_REMEDIATED_NON_BLOCKING: '0',
      HAM_FAILING_TESTS_FIXED: 'suite already green', HAM_DOC_CURRENCY: 'not applicable',
      HAM_DOC_CURRENCY_REASON: `changed files covered: ${filename}`, HAM_AUDIT_DETAILS_FILE: join(root, 'details.md') };
    writeFileSync(env.HAM_AUDIT_DETAILS_FILE, `**Findings addressed**\n- **Fix feature** (blocking): ${filename} repair\nDoc-currency: stale wording\n`);
    const script = join(root, 'publish.sh');
    writeFileSync(script, (await exec(process.execPath, [join(repoRoot, 'bin/hammer-procedure.mjs'), 'hammer-publish', '--render'], { env, timeout: 10000 })).stdout);
    const run = (command, args, extra = {}) => exec(command, args, { cwd: work, env, timeout: 20000, ...extra });
    await run('/bin/bash', ['-c', 'source "$1"', '_', script], { env: { ...env, HAM_COMMIT_PUBLICATION_ONLY: '1' } });
    const published = await git('rev-parse', 'HEAD');
    assert.equal(await git('--git-dir', remote, 'rev-parse', 'refs/heads/worker'), published);
    assert.equal(await git('rev-parse', 'HEAD^{tree}'), localTree);
    assert.equal(published === local, route !== 'api');
    await run('/bin/bash', ['-c', `set -e
HAM_MERGE_LEASE_HELD=1
ham_is_full_sha() { [[ "$1" =~ ^[0-9a-f]{40}$ ]]; }
ham_release_merge_lease() { HAM_MERGE_LEASE_HELD=0; }
source "$1"
`, '_', script]);
    const get = async path => JSON.parse((await run('gh', ['api', path])).stdout);
    const rawCommit = await get(`repos/fixture/repo/commits/${published}`);
    assert.equal(rawCommit.commit.verification.verified, route === 'api');
    assert.equal(rawCommit.committer.login, route === 'api' ? 'web-flow' : 'hammer-worker');
    const primary = await fetchPrimaryChange({ repo: 'fixture/repo', prNumber: Number(pr), headSha: published,
      get, rootDir: root }, { fetchCiCostImpl: async ({ headSha }) => ({ headSha, ok: true }) });
    const snapshot = await fetchHammerPr('fixture/repo', pr, { read: get });
    const comments = JSON.parse(readFileSync(commentsPath, 'utf8'));
    assert.equal(comments.length, 1);
    assert.match(comments[0].body, /^Doc-currency: not applicable; changed files covered: src\/feature.mjs$/m);
    assert.doesNotMatch(comments[0].body, /stale wording/);
    const evidence = buildHamTerminalRemediationEvidenceFromGroundTruth({ reviewedHead: reviewed,
      verifiedCommit: normalizeVerifiedCloserCommit(rawCommit), verifiedAuditComment: comments[0] });
    const paths = { pr: snapshot, reviews: { reviews: [{ state: 'CHANGES_REQUESTED',
      author: { login: amaAuthoritativeReviewerLoginsForModel('codex')[0] }, commit: { oid: reviewed },
      submittedAt: '2026-01-01T00:00:00Z', body: '## Blocking issues\n- **Fix feature** Repair the feature.\n## Non-blocking issues\n- None.\n## Verdict\nRequest changes' }] },
      protection: { required_status_checks: { contexts: ['agent-os/adversarial-gate'] } },
      timeline: comments.map(comment => ({ event: 'commented', ...comment })),
      'ham-terminal-remediation': evidence, 'ham-commit': rawCommit, 'primary-change': primary,
      'ham-range': JSON.parse(readFileSync(join(env.TMPDIR, `ham-${pr}-range.json`), 'utf8')) };
    const args = [];
    for (const [key, value] of Object.entries(paths)) {
      const path = join(root, `${key}.json`); writeFileSync(path, JSON.stringify(value)); args.push(`--${key}`, path);
    }
    const verdict = JSON.parse((await run(process.execPath, [join(repoRoot, 'bin/ama-check.mjs'), ...args,
      '--repo', 'fixture/repo', '--root-dir', root, '--reviewed-sha', reviewed, '--reviewer', 'codex', '--risk-class', 'low'])).stdout);
    assert.equal(verdict.eligible, true, JSON.stringify(verdict));
    for (const name of ['commitIdentity', 'docCurrency', 'primaryChange', 'exactValidation']) {
      assert.equal(verdict.trace.hamTerminalRemediation.checks[name], true, name);
    }
    assert.equal(verdict.trace.ciGreen.green, true);
    const calls = JSON.parse(readFileSync(callsPath, 'utf8'));
    assert.equal(calls.some(args => args[1] === 'graphql'), route !== 'git-tracking');
  });
}
