import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { loadStagePrompt } from '../src/kernel/prompt-stage.mjs';
import { runStandaloneReview, standaloneMain } from '../src/standalone-review.mjs';

const execFileAsync = promisify(execFile);
const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(testDir);
const fixture = (name) => path.join(testDir, 'fixtures', 'standalone', name);
const readFixture = (name) => readFileSync(fixture(name), 'utf8');

const APACHE_2_0_SHA256 = 'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4';
const SYNTHETIC_KEY = 'sk-synthetic-standalone-fixture-key';

function capture() {
  const out = [];
  const err = [];
  return {
    stdout: { write: (chunk) => out.push(String(chunk)) },
    stderr: { write: (chunk) => err.push(String(chunk)) },
    out: () => out.join(''),
    err: () => err.join(''),
  };
}

// A stub provider transport: records the request and answers with `reply`
// in the response shape of the named provider. No socket is ever opened.
function stubFetch(provider, reply, { status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const payload = provider === 'anthropic'
      ? { content: [{ type: 'text', text: reply }] }
      : { choices: [{ message: { role: 'assistant', content: reply } }] };
    return new Response(status === 200 ? JSON.stringify(payload) : reply, { status });
  };
  return { fetchImpl, calls };
}

test('license files: verbatim Apache-2.0 LICENSE and a NOTICE naming the copyright holder', () => {
  const licensePath = path.join(repoRoot, 'LICENSE');
  const noticePath = path.join(repoRoot, 'NOTICE');
  assert.ok(existsSync(licensePath), 'LICENSE exists');
  assert.ok(existsSync(noticePath), 'NOTICE exists');
  assert.equal(
    createHash('sha256').update(readFileSync(licensePath)).digest('hex'),
    APACHE_2_0_SHA256,
    'LICENSE is the verbatim, unmodified Apache License 2.0 text',
  );
  const notice = readFileSync(noticePath, 'utf8');
  assert.match(notice, /Lacey Enterprises LLC/);
  assert.match(notice, /Apache License, Version 2\.0/);
});

for (const provider of ['anthropic', 'openai']) {
  test(`standalone review: ${provider} stub provider returns a request-changes verdict (exit 1)`, async () => {
    const reply = readFixture('review-request-changes.md');
    const { fetchImpl, calls } = stubFetch(provider, reply);
    const io = { ...capture(), env: {
      ANTHROPIC_API_KEY: provider === 'anthropic' ? SYNTHETIC_KEY : undefined,
      OPENAI_API_KEY: provider === 'openai' ? SYNTHETIC_KEY : undefined,
    }, fetchImpl };
    const code = await standaloneMain(
      ['--provider', provider, '--model', 'stub-model', '--diff', fixture('sample.diff'), '--json'], io);

    assert.equal(code, 1);
    const result = JSON.parse(io.out());
    assert.equal(result.verdict, 'request-changes');
    assert.equal(result.provider, provider);
    assert.match(result.review, /## Blocking issues/);

    assert.equal(calls.length, 1);
    const [{ url, init, body }] = calls;
    assert.equal(url, provider === 'anthropic'
      ? 'https://api.anthropic.com/v1/messages'
      : 'https://api.openai.com/v1/chat/completions');
    assert.equal(body.model, 'stub-model');
    const system = provider === 'anthropic' ? body.system : body.messages[0].content;
    const user = body.messages.at(-1).content;
    assert.equal(
      system,
      loadStagePrompt({ rootDir: repoRoot, promptSet: 'code-pr', actor: 'reviewer', stage: 'first' }),
      'the system prompt is the kernel staged reviewer prompt',
    );
    assert.ok(user.includes("const label = name.trim();"), 'the diff is the review subject');
    const authHeader = provider === 'anthropic' ? init.headers['x-api-key'] : init.headers.authorization;
    assert.ok(authHeader.includes(SYNTHETIC_KEY));
  });
}

test('standalone review: comment-only verdict exits 0 and prints the review', async () => {
  const { fetchImpl } = stubFetch('anthropic', readFixture('review-comment-only.md'));
  const io = { ...capture(), env: { ANTHROPIC_API_KEY: SYNTHETIC_KEY }, fetchImpl };
  const code = await standaloneMain(
    ['--provider', 'anthropic', '--model', 'stub-model', '--diff', fixture('sample.diff')], io);
  assert.equal(code, 0);
  assert.match(io.out(), /## Verdict\nComment only/);
  assert.match(io.err(), /verdict: comment-only/);
});

test('standalone review: --base-url routes to a gateway and a trailing slash is tolerated', async () => {
  const { fetchImpl, calls } = stubFetch('openai', readFixture('review-comment-only.md'));
  const result = await runStandaloneReview({
    diff: readFixture('sample.diff'),
    provider: 'openai',
    model: 'stub-model',
    apiKey: SYNTHETIC_KEY,
    baseUrl: 'http://gateway.invalid:8080/',
    fetchImpl,
  });
  assert.equal(result.verdict, 'comment-only');
  assert.equal(calls[0].url, 'http://gateway.invalid:8080/v1/chat/completions');
});

test('standalone review fails closed instead of passing an unreadable review', async (t) => {
  const run = (reply, extra = {}) => runStandaloneReview({
    diff: readFixture('sample.diff'),
    provider: 'anthropic',
    model: 'stub-model',
    apiKey: SYNTHETIC_KEY,
    fetchImpl: stubFetch('anthropic', reply, extra).fetchImpl,
  });

  await t.test('free text with no review sections is rejected', async () => {
    await assert.rejects(run('Looks fine to me.'), /reviewer reply rejected/);
  });
  await t.test('a verdict without the required sections is rejected', async () => {
    await assert.rejects(run('## Verdict\nApproved'), /reviewer reply rejected/);
  });
  await t.test('request-changes without a blocking finding is rejected', async () => {
    const reply = readFixture('review-request-changes.md')
      .replace(/## Blocking issues[\s\S]*## Non-blocking issues/, '## Blocking issues\n- None.\n\n## Non-blocking issues');
    await assert.rejects(run(reply), /reviewer reply rejected/);
  });
  await t.test('an HTTP error surfaces as an error without leaking the key', async () => {
    await assert.rejects(
      run(`upstream rejected key ${SYNTHETIC_KEY}`, { status: 401 }),
      (error) => /HTTP 401/.test(error.message) && !error.message.includes(SYNTHETIC_KEY),
    );
  });
  await t.test('a transport failure is an error', async () => {
    await assert.rejects(runStandaloneReview({
      diff: readFixture('sample.diff'),
      provider: 'openai',
      model: 'stub-model',
      apiKey: SYNTHETIC_KEY,
      fetchImpl: async () => { throw new Error(`connect refused (${SYNTHETIC_KEY})`); },
    }), (error) => /request failed/.test(error.message) && !error.message.includes(SYNTHETIC_KEY));
  });
});

test('standalone review validates inputs before any provider call', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; throw new Error('must not be called'); };
  const base = { provider: 'anthropic', model: 'm', apiKey: SYNTHETIC_KEY, fetchImpl };
  const diff = readFixture('sample.diff');

  await assert.rejects(runStandaloneReview({ ...base, diff: '  \n' }), /diff is empty/);
  await assert.rejects(runStandaloneReview({ ...base, diff, maxDiffBytes: 10 }), /over the 10-byte limit/);
  await assert.rejects(runStandaloneReview({ ...base, diff, apiKey: '' }), /ANTHROPIC_API_KEY is not set/);
  await assert.rejects(runStandaloneReview({ ...base, diff, model: '' }), /--model is required/);
  await assert.rejects(runStandaloneReview({ ...base, diff, stage: 'bogus' }), /unknown stage/);
  await assert.rejects(runStandaloneReview({ ...base, diff, provider: 'nope' }), /unknown provider/);
  await assert.rejects(runStandaloneReview({ ...base, diff, promptSet: '../escape' }), /cannot load prompts/);
  assert.equal(called, false);
});

test('standalone CLI usage errors exit 2, and --help exits 0', async () => {
  const run = async (argv, env = {}) => {
    const io = { ...capture(), env, fetchImpl: async () => { throw new Error('no network'); } };
    return { code: await standaloneMain(argv, io), io };
  };
  assert.equal((await run(['--help'])).code, 0);
  assert.equal((await run(['--provider', 'anthropic', '--model', 'm'])).code, 2);
  assert.equal((await run(['--provider', 'x', '--diff', fixture('sample.diff')])).code, 2);
  assert.equal((await run(['--provider', 'anthropic', '--model', 'm', '--diff', fixture('sample.diff'), '--bogus'])).code, 2);
  assert.equal((await run(['--provider', 'anthropic', '--model', 'm', '--diff', fixture('sample.diff'), '--base', 'main'])).code, 2);
  assert.equal((await run(['--provider', 'anthropic', '--model', 'm', '--base', '--upload-pack=x'])).code, 2);
  assert.equal((await run(['--provider', 'anthropic', '--model', 'm', '--diff', 'missing.diff'])).code, 2);
  assert.equal((await run(['--provider', 'anthropic', '--model', 'm', '--diff', fixture('sample.diff'), '--timeout-ms', '0'])).code, 2);
  const missingKey = await run(['--provider', 'openai', '--model', 'm', '--diff', fixture('sample.diff')]);
  assert.equal(missingKey.code, 2);
  assert.match(missingKey.io.err(), /OPENAI_API_KEY is not set/);
});

test('standalone path imports only the kernel and Node built-ins (no host, daemon or submodule graph)', () => {
  const source = readFileSync(path.join(repoRoot, 'src', 'standalone-review.mjs'), 'utf8');
  const specifiers = [...source.matchAll(/^\s*(?:import|\} from)\b[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  assert.ok(specifiers.length > 0);
  for (const specifier of specifiers) {
    assert.ok(
      specifier.startsWith('node:') || specifier.startsWith('./kernel/'),
      `unexpected import ${specifier}`,
    );
  }
  assert.doesNotMatch(source, /\/Users\/|HQ_ROOT|agent-os/);
});

test('standalone entrypoint boots with a bare environment: no config, HOME or host variables', async () => {
  const env = { PATH: process.env.PATH };
  const entry = path.join(repoRoot, 'src', 'standalone-review.mjs');
  const help = await execFileAsync(process.execPath, [entry, '--help'], { env, cwd: testDir });
  assert.match(help.stdout, /--provider <anthropic\|openai>/);

  await assert.rejects(
    execFileAsync(process.execPath, [
      entry, '--provider', 'anthropic', '--model', 'm', '--diff', fixture('sample.diff'),
    ], { env, cwd: testDir }),
    (error) => error.code === 2 && /ANTHROPIC_API_KEY is not set/.test(error.stderr),
  );
});

test('adversarial-review standalone dispatches from the main CLI without touching other commands', async () => {
  const { main } = await import('../src/cli.mjs');
  const { fetchImpl } = stubFetch('openai', readFixture('review-comment-only.md'));
  const io = { ...capture(), env: { OPENAI_API_KEY: SYNTHETIC_KEY }, fetchImpl };
  const code = await main(
    ['standalone', '--provider', 'openai', '--model', 'stub-model', '--diff', fixture('sample.diff'), '--json'], io);
  assert.equal(code, 0);
  assert.equal(JSON.parse(io.out()).verdict, 'comment-only');

  const unknown = capture();
  assert.equal(await main(['not-a-command'], unknown), 2);
});
