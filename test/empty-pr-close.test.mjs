import test from 'node:test';
import assert from 'node:assert/strict';
import { closeEmptyPullRequest } from '../src/empty-pr-close.mjs';
import { OPERATOR_HOLD_LABELS } from '../src/operator-hold-labels.mjs';

const headSha = 'a'.repeat(40), baseSha = 'b'.repeat(40);
const open = { state: 'open', draft: false, labels: [], changed_files: 0,
  head: { sha: headSha }, base: { sha: baseSha } };

for (const [name, unsafe] of [
  ['draft', { draft: true }],
  ['unknown draft', { draft: undefined }],
  ['unknown labels', { labels: undefined }],
  ...OPERATOR_HOLD_LABELS.flatMap(label => [
    [label, { labels: [{ name: label }] }],
    [`${label} string`, { labels: [label] }],
  ]),
]) for (const phase of ['initial', 'fresh']) {
  test(`empty PR ${name} on ${phase} read is never closed`, async () => {
    let reads = 0;
    const result = await closeEmptyPullRequest({ repo: 'fixture/repo', prNumber: 1, headSha,
      execFileImpl: async (_command, args) => {
        assert.equal(args[0], 'api', 'unsafe PR must not receive a close or comment');
        if (args[1].includes('/compare/')) return { stdout: JSON.stringify({ files: [] }) };
        reads++;
        const apply = phase === 'initial' || reads === 2;
        return { stdout: JSON.stringify(apply ? { ...open, ...unsafe } : open) };
      } });
    assert.equal(result.closed, false);
    assert.equal(reads, phase === 'initial' ? 1 : 2);
  });
}

test('fresh empty PR metadata must still show zero changed files', async () => {
  let reads = 0;
  const result = await closeEmptyPullRequest({ repo: 'fixture/repo', prNumber: 1, headSha,
    execFileImpl: async (_command, args) => {
      assert.equal(args[0], 'api');
      if (args[1].includes('/compare/')) return { stdout: '{"files":[]}' };
      return { stdout: JSON.stringify({ ...open, changed_files: ++reads === 1 ? 0 : 1 }) };
    } });
  assert.equal(result.closed, false);
});

test('failed close never posts a comment; retry closes then comments exactly once with telemetry', async () => {
  let closed = false, closes = 0, comments = 0, telemetry = 0;
  const args = { repo: 'fixture/repo', prNumber: 2, headSha, logger: { warn() {} },
    withApiTelemetry: async (_category, _context, call) => { telemetry++; return call(); },
    execFileImpl: async (_cmd, argv) => {
      if (argv[0] === 'api') return { stdout: JSON.stringify(argv[1].includes('/compare/') ? { files: [] } : { ...open, state: closed ? 'closed' : 'open' }) };
      if (argv[1] === 'close') { if (++closes === 1) throw new Error('close failed'); closed = true; }
      else { assert.equal(closed, true); comments++; }
      return { stdout: '' };
    } };
  assert.equal((await closeEmptyPullRequest(args)).closed, false);
  assert.equal(comments, 0);
  assert.equal((await closeEmptyPullRequest(args)).closed, true);
  await closeEmptyPullRequest(args);
  assert.equal(comments, 1); assert.equal(closes, 2); assert.equal(telemetry, 10);
});
