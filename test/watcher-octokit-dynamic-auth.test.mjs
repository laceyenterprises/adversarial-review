import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { Octokit } from '@octokit/rest';
import { createWatcherOctokit } from '../src/conditional-request.mjs';

// Fake octokit whose before-hook captures the registered handler so we can drive
// it like a real request and observe the Authorization header the watcher sends.
function makeFakeOctokit() {
  let beforeHandler = null;
  return {
    constructedAuth: null,
    hook: { before: (event, fn) => { if (event === 'request') beforeHandler = fn; } },
    runRequest(options) { if (beforeHandler) beforeHandler(options); return options; },
  };
}

test('createWatcherOctokit: authProvider refreshes the Authorization header per request (live token)', () => {
  const fake = makeFakeOctokit();
  let liveToken = 'ghs_TOKEN_V1';
  const octokit = createWatcherOctokit({
    auth: 'ghs_CONSTRUCT_TIME',
    octokitFactory: ({ auth }) => { fake.constructedAuth = auth; return fake; },
    authProvider: () => liveToken,
  });
  assert.equal(fake.constructedAuth, undefined, 'dynamic mode must not snapshot constructor auth');
  // First request uses the live token, not the construct-time snapshot.
  let opts = octokit.runRequest({ headers: {} });
  assert.equal(opts.headers.authorization, 'token ghs_TOKEN_V1');
  // After a broker rotation, the SAME long-lived octokit picks up the new token.
  liveToken = 'ghs_TOKEN_V2_ROTATED';
  opts = octokit.runRequest({ headers: {} });
  assert.equal(opts.headers.authorization, 'token ghs_TOKEN_V2_ROTATED');
});

test('createWatcherOctokit: real Octokit request pipeline sends the refreshed token', async () => {
  let liveToken = 'ghs_LIVE';
  let observedAuthorization = null;
  const octokit = createWatcherOctokit({
    auth: 'ghs_STALE_CONSTRUCTOR',
    authProvider: () => liveToken,
    octokitFactory: (options) => new Octokit({
      ...options,
      request: {
        fetch: async (_url, options) => {
          observedAuthorization = options?.headers?.authorization || options?.headers?.Authorization || null;
          return new Response(JSON.stringify({ login: 'test-user' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        },
      },
    }),
  });

  await octokit.request('GET /user');
  assert.equal(observedAuthorization, 'token ghs_LIVE');

  liveToken = 'ghs_ROTATED';
  await octokit.request('GET /user');
  assert.equal(observedAuthorization, 'token ghs_ROTATED');
});

test('createWatcherOctokit: without authProvider, no hook is installed (back-compat)', () => {
  const fake = makeFakeOctokit();
  createWatcherOctokit({ auth: 'ghs_X', octokitFactory: () => fake });
  const opts = fake.runRequest({ headers: {} });
  assert.equal(opts.headers.authorization, undefined, 'no dynamic hook when authProvider omitted');
});

test('createWatcherOctokit: fail-open when authProvider yields nothing (keeps existing request auth)', () => {
  const fake = makeFakeOctokit();
  const octokit = createWatcherOctokit({
    auth: 'ghs_CONSTRUCT', octokitFactory: () => fake, authProvider: () => '',
  });
  const opts = octokit.runRequest({ headers: { authorization: 'token ghs_CONSTRUCT' } });
  // Empty provider -> don't overwrite any request auth already in place.
  assert.equal(opts.headers.authorization, 'token ghs_CONSTRUCT');
});
