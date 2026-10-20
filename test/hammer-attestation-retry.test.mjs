import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { renderHammerProcedure } from '../src/hammer-procedure.mjs';
import { readAmaAuditEntry } from '../src/ama/audit.mjs';
import { hammerAttestationChain } from '../src/ama/hammer-head-validation.mjs';
import { isTransientGhError } from '../src/gh-cli.mjs';
import { recordPendingAttestation } from '../src/ama/hammer-pending-attestation.mjs';

const root = resolve(import.meta.dirname, '..');
const reviewed = 'a'.repeat(40), validated = 'b'.repeat(40), other = 'c'.repeat(40);
const errors = ['Something went wrong while executing your query',
  'sOmEtHiNg WeNt WrOnG wHiLe ExEcUtInG yOuR qUeRy',
  '{"errors":[{"type": "INTERNAL"}]}', 'GraphQL: HTTP/2 500', '{"status":500,"errors":[]}'];

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'hammer-attestation-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const commentsPath = join(dir, 'comments.json');
  writeFileSync(commentsPath, '[]');
  writeFileSync(join(dir, 'details.md'), '- **Repair validation** (blocking): src/example.mjs: repaired\n');
  const executable = (name, source) => writeFileSync(join(bin, name), source, { mode: 0o755 });
  executable('git', '#!/bin/sh\nprintf "%s\\n" "$CURRENT_HEAD"\n');
  executable('gh', `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2), dir = process.env.FIXTURE_DIR;
const countPath = dir + '/post-count';
if (args[0] === 'api' && args[1] === 'graphql') {
  console.log(JSON.stringify({ login: process.env.APP_LOGIN || 'hammer-worker', databaseId: Number(process.env.APP_ID || 77) }));
} else if (args[0] === 'pr' && args[1] === 'view') {
  const readsPath = dir + '/head-reads';
  const reads = fs.existsSync(readsPath) ? Number(fs.readFileSync(readsPath, 'utf8')) + 1 : 1;
  fs.writeFileSync(readsPath, String(reads));
  console.log(process.env.MOVE_HEAD && reads > 1 ? process.env.MOVE_HEAD : process.env.CURRENT_HEAD);
} else if (args[0] === 'api' && args.includes('--paginate')) {
  console.log(JSON.stringify([JSON.parse(fs.readFileSync(process.env.COMMENTS_PATH, 'utf8'))]));
} else if (args[0] === 'api' && args.includes('PATCH')) {
  const comments = JSON.parse(fs.readFileSync(process.env.COMMENTS_PATH, 'utf8'));
  const id = Number(args.find(arg => arg.startsWith('repos/')).split('/').at(-1));
  comments.find(comment => comment.id === id).body = args.find(arg => arg.startsWith('body=')).slice(5);
  fs.writeFileSync(process.env.COMMENTS_PATH, JSON.stringify(comments));
} else if (args[0] === 'pr' && args[1] === 'comment') {
  const n = fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, 'utf8')) + 1 : 1;
  fs.writeFileSync(countPath, String(n));
  if (n <= Number(process.env.FAIL_COUNT || 0)) {
    (process.env.ERROR_STDOUT ? process.stdout : process.stderr).write(process.env.POST_ERROR || 'Something went wrong while executing your query');
    process.exit(1);
  }
  const comments = JSON.parse(fs.readFileSync(process.env.COMMENTS_PATH, 'utf8'));
  comments.push({ id: n, author: process.env.APP_LOGIN || 'hammer-worker', body: args[args.indexOf('--body') + 1] });
  fs.writeFileSync(process.env.COMMENTS_PATH, JSON.stringify(comments));
} else {
  fs.writeFileSync(dir + '/unexpected-gh', JSON.stringify(args));
  process.exit(1);
}
`);
  // Only proof and lease reads are substituted; the durable audit writer and
  // pending-edge selector execute the production modules against temporary HQ.
  executable('node-fixture', `#!/bin/bash
case "$1" in
  */bin/metered-gh.mjs) shift 2; exec gh "$@" ;;
  */bin/hammer-pr-read.mjs) exec gh pr view ;;
  */bin/merge-lease.mjs)
    if [ -f "$FIXTURE_DIR/lease-lost" ]; then echo '{"holder":null}'; else
      echo '{"holder":{"leaseId":"test-lease","holderPr":42,"pastDeadline":false,"holderPidLive":true,"ageSeconds":1}}'
    fi ;;
  */bin/hammer-head-context.mjs) exec "$REAL_NODE" "$FIXTURE_DIR/proof.mjs" ;;
  *) exec "$REAL_NODE" "$@" ;;
esac
`);
  writeFileSync(join(dir, 'proof.mjs'), `
import { readFileSync } from 'node:fs';
import { fetchHammerHeadRange } from ${JSON.stringify(join(root, 'src/ama/hammer-head-validation.mjs'))};
const env = process.env;
const range = await fetchHammerHeadRange({ repo: 'fixture/repo', reviewedHead: env.REVIEWED_HEAD,
  currentHead: env.CURRENT_HEAD, hammerBaseHead: env.HAM_BASE_HEAD,
  comments: JSON.parse(readFileSync(env.COMMENTS_PATH, 'utf8')), get: async () => ({}) });
if (!range) process.exit(65);
console.log(JSON.stringify(range));
`);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FIXTURE_DIR: dir, COMMENTS_PATH: commentsPath,
    REAL_NODE: process.execPath, CURRENT_HEAD: validated, REVIEWED_HEAD: reviewed,
    HAM_NODE_BIN: join(bin, 'node-fixture'), HAM_RUN_DIR: dir, HAM_BASE_HEAD: reviewed,
    HAM_AUDIT_DETAILS_FILE: join(dir, 'details.md'), HAM_AUDIT_REMEDIATED_TOTAL: '1',
    HAM_AUDIT_REMEDIATED_BLOCKING: '1', HAM_AUDIT_REMEDIATED_NON_BLOCKING: '0',
    HAM_DOC_CURRENCY: 'not applicable', HAM_DOC_CURRENCY_REASON: 'src/example.mjs covered',
    HAM_FAILING_TESTS_FIXED: 'validation repaired', HAMMER_LACEY_GH_TOKEN: 'synthetic-token' };
  const run = (overrides = {}) => {
    const runEnv = { ...env, ...overrides };
    rmSync(join(dir, 'head-reads'), { force: true });
    const script = renderHammerProcedure('hammer-publish', { ROOT_DIR: root, RUN_DIR: dir, HQ_ROOT: dir,
      REPO: 'fixture/repo', PR_NUMBER: '42', PR_URL: 'https://github.com/fixture/repo/pull/42', REVIEWED_SHA: runEnv.REVIEWED_HEAD });
    writeFileSync(join(dir, 'publish.sh'), script);
    const result = spawnSync('/bin/bash', ['-c', `
HAM_MERGE_LEASE_HELD=1
HAM_MERGE_LEASE_ID=test-lease
BASE_BRANCH=main
ham_mark_merge_lease_retryable_abort() { HAM_RETRYABLE_ABORT_REASON="$1"; }
ham_release_merge_lease() { HAM_RELEASE_RETRYABLE_ABORT_REASON="\${HAM_RETRYABLE_ABORT_REASON:-}"; HAM_MERGE_LEASE_HELD=0; }
ham_is_full_sha() { [[ "$1" =~ ^[a-f0-9]{40}$ ]]; }
sleep() { echo "$1" >> "$FIXTURE_DIR/backoffs"; if [ "\${LOSE_LEASE:-0}" = 1 ]; then touch "$FIXTURE_DIR/lease-lost"; fi; }
source "$FIXTURE_DIR/publish.sh"
status=$?
echo "status=$status outcome=$HAM_PHASE_OUTCOME held=$HAM_MERGE_LEASE_HELD published=$HAM_PUBLISHED_AUDIT_HEAD"
echo "note=\${HAM_NO_MERGE_NOTE:-}"
echo "release-retryable=\${HAM_RELEASE_RETRYABLE_ABORT_REASON:-}"
exit "$status"
`], { env: runEnv, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.signal, null, result.stderr);
    assert.equal(existsSync(join(dir, 'unexpected-gh')), false);
    return result;
  };
  return { dir, run, comments: () => JSON.parse(readFileSync(commentsPath, 'utf8')),
    posts: () => Number(readFileSync(join(dir, 'post-count'), 'utf8')),
    audit: () => readAmaAuditEntry(dir, 'fixture/repo', 42, validated) };
}

for (const error of errors) {
  test(`audit retries transient response: ${error}`, t => {
    const f = fixture(t);
    const result = f.run({ FAIL_COUNT: '1', POST_ERROR: error });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(f.posts(), 2);
    assert.equal(readFileSync(join(f.dir, 'backoffs'), 'utf8'), '2\n');
    assert.equal(f.audit(), null);
    assert.equal(isTransientGhError({ stdout: error }), true);
  });
}

test('five transient failures retain only a validated edge and allow next leased hammer to prove provenance', t => {
  const f = fixture(t);
  const failed = f.run({ FAIL_COUNT: '5', ERROR_STDOUT: '1' });
  assert.equal(failed.status, 1, failed.stderr);
  assert.equal(f.posts(), 5);
  assert.match(failed.stdout, /held=0 published=\n/);
  assert.match(failed.stdout, /failed transiently.*next hammer will recover/);
  assert.match(failed.stdout, /release-retryable=audit-comment-unavailable/);
  assert.doesNotMatch(failed.stdout, /exact-head-review-required/);
  assert.equal(readFileSync(join(f.dir, 'backoffs'), 'utf8'), '2\n4\n8\n16\n');
  const audit = f.audit();
  assert.equal(audit.status, 'deferred');
  assert.deepEqual(audit.attempts.at(-1).pendingAttestation, {
    baseHead: reviewed, validatedHead: validated, identity: { login: 'hammer-worker', databaseId: 77 },
    validationSummary: { rangeVerified: true, total: 1, blocking: 1, nonBlocking: 0 } });
  assert.doesNotMatch(JSON.stringify(audit), /synthetic-token|Something went wrong|Repair validation/);
  assert.deepEqual(f.comments(), []);
  rmSync(join(f.dir, 'range.json'));
  rmSync(join(f.dir, 'audit-identity.json'));
  const resumed = f.run({ HAM_BASE_HEAD: validated });
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.match(resumed.stdout, /outcome=published held=1/);
  assert.deepEqual(hammerAttestationChain(f.comments(), reviewed, validated), [validated]);
  assert.match(f.comments()[0].body, /ham-recovered-attestation/);
  assert.equal(JSON.parse(readFileSync(join(f.dir, 'range.json'), 'utf8')).proof, 'hammer-app-attestation-chain');
  const again = f.run({ HAM_BASE_HEAD: validated });
  assert.equal(again.status, 0, again.stderr);
  assert.equal(f.comments().filter(comment => comment.body.includes('ham-recovered-attestation')).length, 1);
});

test('permanent audit error stops after one attempt and retains the validated edge', t => {
  const f = fixture(t);
  const result = f.run({ FAIL_COUNT: '5', POST_ERROR: 'Resource not accessible by integration (HTTP 403)' });
  assert.equal(result.status, 1);
  assert.equal(f.posts(), 1);
  assert.equal(existsSync(join(f.dir, 'backoffs')), false);
  assert.ok(f.audit().attempts.at(-1).pendingAttestation);
  assert.equal(isTransientGhError({ stderr: 'HTTP 403' }), false);
});

for (const [kind, error, attempts] of [
  ['transient', 'Something went wrong while executing your query', 5],
  ['permanent', 'Resource not accessible by integration (HTTP 403)', 1],
]) {
  test(`${kind} recovery delivery failure marks the lease retryable before release`, t => {
    const f = fixture(t);
    assert.equal(f.run({ FAIL_COUNT: '5' }).status, 1);
    const pendingAudit = f.audit();
    rmSync(join(f.dir, 'backoffs'));
    const result = f.run({ HAM_BASE_HEAD: validated, FAIL_COUNT: '10', POST_ERROR: error });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /outcome=audit-comment-unavailable held=0 published=\n/);
    assert.match(result.stdout, /release-retryable=audit-comment-unavailable/);
    assert.equal(f.posts(), 5 + attempts);
    if (attempts === 5) {
      assert.equal(readFileSync(join(f.dir, 'backoffs'), 'utf8'), '2\n4\n8\n16\n');
    } else {
      assert.equal(existsSync(join(f.dir, 'backoffs')), false);
    }
    assert.deepEqual(f.audit(), pendingAudit);
    assert.deepEqual(f.comments(), []);
  });
}

for (const head of ['', validated.slice(0, 39), 'malformed-head']) {
  test(`unresolved post-remediation head emits a diagnostic: ${head || 'empty'}`, t => {
    const f = fixture(t);
    const result = f.run({ CURRENT_HEAD: head });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /HAM hard-blocker: unable to resolve post-remediation head before audit comment/);
    assert.match(result.stdout, /held=0 published=\n/);
    assert.equal(existsSync(join(f.dir, 'post-count')), false);
    assert.equal(f.audit(), null);
    assert.deepEqual(f.comments(), []);
  });
}

for (const [kind, overrides] of [
  ['head', { CURRENT_HEAD: other, HAM_BASE_HEAD: other }],
  ['base', { REVIEWED_HEAD: other, HAM_BASE_HEAD: validated }],
  ['identity id', { APP_ID: '88', HAM_BASE_HEAD: validated }],
  ['identity login', { APP_LOGIN: 'fixture-other-app', HAM_BASE_HEAD: validated }],
]) {
  test(`pending edge with different ${kind} cannot authorize provenance`, t => {
    const f = fixture(t);
    assert.equal(f.run({ FAIL_COUNT: '5' }).status, 1);
    const result = f.run(overrides);
    assert.equal(result.status, 20, result.stderr);
    assert.match(result.stdout, /outcome=exact-head-review-required held=0/);
    assert.equal(f.posts(), 5);
    assert.deepEqual(f.comments(), []);
  });
}

test('lease loss between retries stops posting and preserves validated recovery evidence', t => {
  const f = fixture(t);
  const result = f.run({ FAIL_COUNT: '5', LOSE_LEASE: '1' });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(f.posts(), 1);
  assert.match(result.stderr, /merge lease lost/);
  assert.ok(f.audit().attempts.at(-1).pendingAttestation);
  assert.deepEqual(f.comments(), []);
});

test('head movement immediately before recovery cannot publish a pending edge', t => {
  const f = fixture(t);
  assert.equal(f.run({ FAIL_COUNT: '5' }).status, 1);
  const result = f.run({ HAM_BASE_HEAD: validated, MOVE_HEAD: other });
  assert.equal(result.status, 20, result.stderr);
  assert.match(result.stdout, /outcome=exact-head-review-required/);
  assert.match(result.stdout, /release-retryable=\n/);
  assert.equal(f.posts(), 5);
});

test('recovery retries stop on lease loss and retain the earlier edge', t => {
  const f = fixture(t);
  assert.equal(f.run({ FAIL_COUNT: '5' }).status, 1);
  const result = f.run({ HAM_BASE_HEAD: validated, FAIL_COUNT: '10', LOSE_LEASE: '1' });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(f.posts(), 6);
  assert.match(result.stderr, /merge lease lost/);
  assert.equal(f.audit().attempts.length, 1);
  assert.deepEqual(f.comments(), []);
});

test('an unvalidated range cannot produce durable attestation evidence', t => {
  const f = fixture(t);
  for (const range of [null, { verified: false },
    { verified: true, reviewedHead: other, currentHead: validated, baseSha: reviewed, commits: [validated] },
    { verified: true, reviewedHead: reviewed, currentHead: other, baseSha: reviewed, commits: [other] }]) {
    assert.throws(() => recordPendingAttestation({ hqRoot: f.dir, repo: 'fixture/repo', prNumber: 42,
      baseHead: reviewed, validatedHead: validated, identity: { login: 'hammer-worker', databaseId: 77 },
      range, counts: { total: 1, blocking: 1, nonBlocking: 0 } }), /invalid pending hammer attestation/);
    assert.equal(f.audit(), null);
  }
});

test('sibling hammer phase classifiers retry GraphQL server errors and refuse permission failures', t => {
  const dir = mkdtempSync(join(tmpdir(), 'hammer-classifiers-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const errorPath = join(dir, 'error.txt');
  for (const [file, name] of [
    ['hammer-verify-head', 'ham_gate_cap_gh_transient'],
    ['hammer-verify-head', 'ham_update_branch_transient'],
    ['hammer-merge', 'ham_merge_error_retryable'],
  ]) {
    const source = readFileSync(join(root, 'bin', `${file}.sh`), 'utf8');
    const body = source.match(new RegExp(`${name}\\(\\) \\{\\n\\s*(grep -Eiq [^\\n]+)\\n\\s*\\}`))?.[1];
    assert.ok(body, `${file}: ${name}`);
    for (const error of [...errors, 'HTTP 403: permission denied']) {
      writeFileSync(errorPath, error);
      const result = spawnSync('/bin/bash', ['-c', `${name}() { ${body}; }\n${name} "$1"`, '_', errorPath],
        { encoding: 'utf8', timeout: 5000 });
      assert.equal(result.status, error.includes('403') ? 1 : 0, `${name}: ${error}: ${result.stderr}`);
    }
  }
});
