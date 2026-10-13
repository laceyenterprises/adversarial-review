import test from 'node:test';
import assert from 'node:assert/strict';
import { filterGitHubBody } from '../src/github-outbound-body.mjs';

const context = {
  repo: 'acme/widgets', reviewerHeadSha: 'reviewed-sha',
  stateDir: '/Users/example/state', homeDir: '/Users/example',
  rootDir: '/home/example/state/service', tempDir: '/home/example/state/tmp',
  env: {},
};
const snapshot = '/Users/example/state/reviewer-snapshots/acme_widgets-0123456789ab/local-sha';
const blob = 'https://github.com/acme/widgets/blob/reviewed-sha/tests/test_example.py';
const filter = (body, options = {}) => filterGitHubBody(body, { ...context, ...options });

for (const anchor of ['', '#L3', '#L3-L8']) {
  test(`snapshot link and bare URL retain repository file and anchor ${anchor}`, () => {
    assert.equal(filter(`[tests/test_example.py](file://${snapshot}/tests/test_example.py${anchor})`), `[tests/test_example.py](${blob}${anchor})`);
    assert.equal(filter(`file://${snapshot}/tests/test_example.py${anchor}`), `${blob}${anchor}`);
  });
}
test('absolute Markdown targets, angle targets and unknown file links', () => {
  assert.equal(filter(`[example](${snapshot}/tests/test_example.py#L4)`), `[example](${blob}#L4)`);
  assert.equal(filter(`[example](<file://${snapshot}/tests/test_example.py#L4>)`), `[example](${blob}#L4)`);
  assert.equal(filter('[example](file:///unknown/place/example.txt)'), 'example.txt');
});
test('plain snapshot path and other runtime roots', () => {
  assert.equal(filter(`${snapshot}/tests/test_example.py`), 'tests/test_example.py');
  for (const [path, expected] of [
    ['/Users/example/state/jobs/reply.json', '<local>/jobs/reply.json'],
    ['/Users/example/notes.txt', '<local>/notes.txt'],
    ['/home/example/state/tmp/work/file.txt', '<local>/work/file.txt'],
    ['/home/example/state/service/src/example.mjs', '<local>/src/example.mjs'],
  ]) {
    assert.equal(filter(path), expected);
    assert.equal(filter(`file://${path}`), expected);
  }
});
test('twenty links change no ordinary prose', () => {
  const before = Array.from({ length: 20 }, (_, i) => `Finding ${i}: [same text](file://${snapshot}/tests/test_example.py#L${i + 1}). Ordinary prose remains.\n`).join('');
  const after = before.replaceAll(`file://${snapshot}/tests/test_example.py`, blob);
  assert.equal(filter(before), after);
  assert.doesNotMatch(filter(before), /file:\/\/|\/Users\/example|\/home\/example/i);
});
test('unrelated quoted diff paths stay byte-identical', () => {
  const quote = '> +const path = "/opt/vendor/unrelated/example.txt";\n';
  assert.equal(filter(quote), quote);
});
test('URL encoding, trailing root slash and mixed scheme case', () => {
  assert.equal(filter(`FILE://${snapshot.replaceAll('/', '%2F')}/tests/test_example.py#L4`, { stateDir: '/Users/example/state/' }), `${blob}#L4`);
  assert.equal(filter('/Users%2Fexample%2Fstate/jobs/x'), '<local>/jobs/x');
  assert.equal(filter('file:///unknown/location/example.txt'), 'example.txt');
});
test('Windows snapshot paths and file URLs', () => {
  const options = { stateDir: 'C:\\Users\\example\\state', homeDir: 'C:\\Users\\example', rootDir: 'C:\\service', tempDir: 'C:\\temp' };
  const path = 'C:\\Users\\example\\state\\reviewer-snapshots\\acme_widgets-0123456789ab\\local-sha\\tests\\test_example.py';
  assert.equal(filter(path, options), 'tests/test_example.py');
  assert.equal(filter(`FILE:///${path.replaceAll('\\', '/')}#L2`, options), `${blob}#L2`);
  assert.equal(filter('C:\\Users\\example\\notes.txt', options), '<local>/notes.txt');
});
test('workspace override and snapshot beneath home root', () => {
  assert.equal(filter('file:///home/example/state/workspace/reviewer-snapshots/acme_widgets/hash/tests/test_example.py', { env: { ADVERSARIAL_REVIEW_WORKSPACE_STATE_DIR: '/home/example/state/workspace' } }), blob);
  assert.equal(filter('file:///Users/example/.agent-os/reviewer-workspace/reviewer-snapshots/acme_widgets/hash/tests/test_example.py'), blob);
});
test('odd input and internal failure do not throw or leak roots', () => {
  assert.equal(filter(null), '');
  assert.equal(filter({ toString() { throw new Error('odd input'); } }), '');
  const options = { ...context, get repo() { throw new Error('internal failure'); } };
  const value = filterGitHubBody(`file://${snapshot}/tests/test_example.py /Users/example/state/jobs/x`, options);
  assert.doesNotMatch(value, /file:\/\/|\/Users\/example/i);
});
test('filter is idempotent', () => {
  const input = `A [file](file://${snapshot}/tests/test_example.py#L4) and /Users/example/state/jobs/x.`;
  assert.equal(filter(filter(input)), filter(input));
});
