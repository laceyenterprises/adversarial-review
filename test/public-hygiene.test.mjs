import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isPublicHygieneRepo, assertPublicSafeReview, PUBLIC_SAFE_REVIEW_ADDENDUM } from '../src/public-hygiene.mjs';
import { buildReviewerExtraContext } from '../src/reviewer-prompt.mjs';
import { buildReviewCommentBody, classifyReviewCommentHeader } from '../src/review-comment-body.mjs';
import { loadConfig, loadConfigRuntime } from '../src/config-loader.mjs';
import { __test__ } from '../src/reviewer.mjs';

const repo = 'example-org/example-repo';
const marked = () => [repo];
const unmarked = () => [];

test('repository matching normalizes surrounding whitespace and case on both sides', () => {
  for (const configured of [repo, ` \t${repo.toUpperCase()}\n`]) {
    for (const input of [repo, ` \t${repo.toUpperCase()}\n`]) {
      assert.equal(isPublicHygieneRepo(input, () => [configured]), true);
    }
    assert.equal(isPublicHygieneRepo('example-org/other-repo', () => [configured]), false);
  }
});

test('clean scanner output tolerates more than 64 KiB on both stdout and stderr', async () => {
  const run = promisify(execFile);
  await assertPublicSafeReview({
    repo, prNumber: 1, reviewBody: 'Code review',
    getConfigImpl: () => [` ${repo.toUpperCase()} `],
    execFileImpl: async (_command, _args, options) => run(process.execPath, ['-e', `
      process.stderr.write('Synthetic diagnostic\\n'.repeat(8192));
      process.stdout.write(' '.repeat(128 * 1024) + '{"status":"clean"}');
    `], options),
    deliverAlertImpl: async () => assert.fail('must not alert'),
  });
});

test('strict and runtime config readers retain deployed hygiene configuration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hygiene-config-'));
  try {
    const topPath = join(directory, 'config.yaml');
    const denylistPath = join(directory, 'patterns.txt');
    await writeFile(denylistPath, 'literal:example-host\n');
    await writeFile(topPath, JSON.stringify({ version: 1, worker_pool: { public_hygiene: {
      repos: [repo], identities: {}, denylist_path: denylistPath,
    } } }));
    for (const loader of [loadConfig, loadConfigRuntime]) {
      const cfg = loader({ topPath, env: {} });
      assert.equal(isPublicHygieneRepo(repo.toUpperCase(), cfg.get.bind(cfg)), true);
      assert.equal(isPublicHygieneRepo('example-org/other-repo', cfg.get.bind(cfg)), false);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('public prompt skips operational context; ordinary prompt is unchanged', async () => {
  const common = {
    repo, prNumber: 1, readTenureReviewRangeImpl: () => null,
    readFindingDisputeReservationsImpl: () => [],
    fetchLinkedSpecContentsImpl: async () => '',
    buildHardeningReviewContextImpl: async () => '',
    log: { warn() {} },
  };
  const safe = await buildReviewerExtraContext({ ...common, getConfigImpl: marked,
    readTenureReviewRangeImpl: () => { throw new Error('must not read operational state'); },
  });
  assert.ok(safe.includes(PUBLIC_SAFE_REVIEW_ADDENDUM));
  assert.ok(!(await buildReviewerExtraContext({ ...common, getConfigImpl: unmarked }))
    .includes(PUBLIC_SAFE_REVIEW_ADDENDUM));
});

test('public template drops metadata, audit blocks and an existing attributed header', () => {
  const options = {
    reviewerMetadata: { displayName: 'Example reviewer', reviewerIdentity: 'example-account' },
    execution: { harness: 'example-host' },
    waiverAuditBlock: '> example-tracker\n\n', reviewModeAuditBlock: '> example-run\n\n',
    reviewText: '## Adversarial Review — Example (example-account)\n\n## Verdict\nComment only',
  };
  const safe = buildReviewCommentBody({ ...options, publicHygiene: true });
  assert.ok(!/example-/.test(safe));
  assert.ok(safe.includes('## Verdict\nComment only'));
  assert.equal(classifyReviewCommentHeader(safe).isAdversarialReview, true);
  assert.ok(buildReviewCommentBody(options).includes('example-host'));
});

for (const scenario of ['hit', 'unavailable', 'malformed', 'refused', 'unmarked', 'config-error']) {
  test(`${scenario} holds before any posting side effect and alerts with redacted locations`, async () => {
    const logs = [];
    const alerts = [];
    let textPath;
    const hygieneOptions = {
      getConfigImpl: scenario === 'config-error' ? () => { throw new Error('example-sensitive'); } : marked,
      execFileImpl: async (command, args) => {
        assert.equal(command, 'hq');
        assert.deepEqual(args.slice(0, 4), ['hygiene', 'scan', '--repo', repo]);
        textPath = args[5];
        assert.equal(await readFile(textPath, 'utf8'), 'example-sensitive');
        if (scenario === 'unavailable') throw new Error('example-sensitive');
        if (scenario === 'malformed') return { stdout: 'example-sensitive' };
        if (scenario === 'hit') throw Object.assign(new Error('example-sensitive'), {
          code: 1, stdout: JSON.stringify({ status: 'hit', kind: 'text', line: 2, rule: 3, value: 'example-sensitive' }),
        });
        return { stdout: JSON.stringify({ status: scenario }) };
      },
      deliverAlertImpl: async (...args) => alerts.push(args),
    };
    await assert.rejects(__test__.postGitHubReview(repo, 1, 'example-sensitive', 'EXAMPLE_TOKEN',
      async () => assert.fail('must not post'), {
        env: { EXAMPLE_TOKEN: 'synthetic-token' }, hygieneOptions,
        log: { error: value => logs.push(value) },
        prepareReviewWrite: async () => assert.fail('must not prepare write'),
      }), { code: 'PUBLIC_HYGIENE_HOLD' });
    assert.equal(alerts.length, 1);
    const hold = JSON.parse(logs[0]);
    assert.equal(hold.event, 'reviewer.public_hygiene_hold');
    if (scenario === 'hit') assert.deepEqual([hold.class, hold.line, hold.rule], ['text', 2, 3]);
    assert.ok(!JSON.stringify({ logs, alerts }).includes('example-sensitive'));
    if (textPath) await assert.rejects(readFile(textPath), { code: 'ENOENT' });
  });
}

test('clean scan allows delivery; ordinary repositories do not invoke scanner', async () => {
  let scans = 0;
  for (const getConfigImpl of [marked, unmarked]) {
    await assertPublicSafeReview({ repo, prNumber: 1, reviewBody: 'Code review', getConfigImpl,
      execFileImpl: async () => { scans++; return { stdout: '{"status":"clean"}' }; },
      deliverAlertImpl: async () => assert.fail('must not alert'),
    });
  }
  assert.equal(scans, 1);
});
