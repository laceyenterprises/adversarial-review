import test from 'node:test';
import assert from 'node:assert/strict';
import { alertPresentationForDoc } from '../src/alert-delivery.mjs';
import { checkReviewServiceIdentityAtBoot, observeReviewServiceToken } from '../src/github-identity-boot.mjs';

const bin = '/fixture/github-adapter';
const quiet = { error() {}, warn() {} };

for (const service of ['watcher', 'follow-up']) {
  test(`${service} pages once per failed role and owner, then continues startup`, async () => {
    const pages = [];
    const failure = { role: 'merge-agent', owner: 'rundix', ok: false, code: 'github-app-owner-not-configured' };
    const env = { GHA_ADAPTER_BIN: bin, [service === 'watcher' ? 'WATCHER_GH_AUTH_VIA_BROKER' : 'FOLLOW_UP_GH_AUTH_VIA_BROKER']: 'true', CODEX_REVIEWER_AUTH_VIA_BROKER: 'true', GH_TOKEN: 'ambient-fixture' };
    const ok = await checkReviewServiceIdentityAtBoot(service, { env, log: quiet,
      deliverAlertImpl: async (_message, page) => pages.push(page),
      execFileImpl: async (command, args, options) => {
        assert.equal(command, bin);
        assert.deepEqual(args, ['identity-check', '--json', '--role', 'merge-agent', '--role', 'codex-reviewer']);
        assert.equal(options.env.GH_TOKEN, undefined);
        const checks = [failure, failure, { ...failure, role: 'codex-reviewer', ok: true, code: 'ok' }];
        throw Object.assign(new Error('identity-check exit 1'), { stdout: JSON.stringify({ ok: false, checks }) });
      },
    });
    assert.equal(ok, false);
    assert.equal(alertPresentationForDoc(pages[0]).severity, 'SEV1');
    assert.deepEqual(pages.map(page => [page.event, page.payload]), [[
      'adversarial_review.github_identity_boot_failed', { service, role: failure.role, owner: failure.owner, code: failure.code },
    ]]);
  });
}

test('a complete identity check queues no pages', async () => {
  const ok = await checkReviewServiceIdentityAtBoot('watcher', { env: { GHA_ADAPTER_BIN: bin, WATCHER_GH_AUTH_VIA_BROKER: 'true' }, log: quiet,
    deliverAlertImpl: () => assert.fail('healthy boots must not page'),
    execFileImpl: async () => ({ stdout: JSON.stringify({ ok: true, checks: [
      { role: 'merge-agent', owner: 'fixture-org', ok: true, code: 'ok' },
      { role: 'merge-agent', owner: 'rundix', ok: true, code: 'ok' },
    ] }) }),
  });
  assert.equal(ok, true);
});

test('follow-up boot checks all remediation publication roles including Grok', async () => {
  await checkReviewServiceIdentityAtBoot('follow-up', {
    env: { GHA_ADAPTER_BIN: bin, MERGE_AGENT_AUTH_VIA_BROKER: 'true' }, log: quiet,
    deliverAlertImpl: () => assert.fail('healthy boots must not page'),
    execFileImpl: async (_command, args) => {
      assert.deepEqual(new Set(args.filter((_, index) => args[index - 1] === '--role')),
        new Set(['merge-agent', 'claude', 'codex', 'gemini', 'grok-agent']));
      return { stdout: JSON.stringify({ ok: true, checks: ['merge-agent', 'claude', 'codex', 'gemini', 'grok-agent'].map(role => ({ role, owner: 'fixture-org', ok: true })) }) };
    },
  });
});

test('a sustained token outage pages once and recovery resets its streak', async () => {
  const pages = [];
  const messages = [];
  const options = { env: {}, log: { warn: message => messages.push(message) },
    deliverAlertImpl: async (_message, page) => pages.push(page) };
  for (let tick = 0; tick < 4; tick++) {
    assert.equal(await observeReviewServiceToken('watcher', false,
      tick === 0 ? { failed: 'broker-unreachable' } : {}, options), false);
    assert.equal(pages.length, tick < 2 ? 0 : 1);
  }
  assert.deepEqual(pages[0].payload, { service: 'watcher', reason: 'broker-unreachable' });
  assert.equal(alertPresentationForDoc(pages[0]).severity, 'SEV1');
  assert.equal(await observeReviewServiceToken('watcher', true, {}, options), true);
  await observeReviewServiceToken('watcher', false, {}, options);
  assert.equal(pages.length, 1);
  assert.match(messages.at(-1), /service-token-missing/);
});

for (const service of ['watcher', 'follow-up']) {
  test(`${service} environment-token boot does not check or page broker roles`, async () => {
    assert.equal(await checkReviewServiceIdentityAtBoot(service, {
      env: { WATCHER_GH_AUTH_VIA_BROKER: 'false', FOLLOW_UP_GH_AUTH_VIA_BROKER: 'false' },
      execFileImpl: () => assert.fail('no broker identity call in environment-token mode'),
      deliverAlertImpl: () => assert.fail('no broker page in environment-token mode'),
    }), true);
  });
}

test('boot identity retries an unstructured transient failure without paging recovery', async () => {
  let attempts = 0;
  const delays = [];
  const ok = await checkReviewServiceIdentityAtBoot('watcher', {
    env: { GHA_ADAPTER_BIN: bin, WATCHER_GH_AUTH_VIA_BROKER: 'true' }, log: quiet,
    sleepImpl: async delay => delays.push(delay),
    execFileImpl: async (_bin, _args, options) => {
      assert.equal(options.timeout, 21_000);
      assert.equal(options.env.AGENT_OS_GITHUB_ADAPTER_RETRY_MAX_ATTEMPTS, '1');
      if (++attempts === 1) throw Object.assign(new Error('synthetic transient'), { code: 75 });
      return { stdout: JSON.stringify({ ok: true, checks: [{ role: 'merge-agent', owner: 'Rundix', ok: true }] }) };
    }, deliverAlertImpl: () => assert.fail('recovered probe must not page'),
  });
  assert.equal(ok, true);
  assert.equal(attempts, 2);
  assert.deepEqual(delays, [100]);
});

test('boot identity preserves mixed-case owner failures and bounds exhausted retries', async () => {
  const pages = [];
  const options = { env: { GHA_ADAPTER_BIN: bin, WATCHER_GH_AUTH_VIA_BROKER: 'true' }, log: quiet,
    sleepImpl: async () => {}, deliverAlertImpl: async (_message, page) => pages.push(page) };
  await checkReviewServiceIdentityAtBoot('watcher', { ...options,
    execFileImpl: async () => ({ stdout: JSON.stringify({ ok: false, checks: [
      { role: 'merge-agent', owner: 'Rundix', ok: false, code: 'github-app-owner-not-configured' },
    ] }) }),
  });
  assert.equal(pages[0].payload.owner, 'rundix');
  assert.equal(pages.length, 1);
  let attempts = 0;
  await checkReviewServiceIdentityAtBoot('watcher', { ...options,
    execFileImpl: async () => { attempts++; throw Object.assign(new Error('synthetic timeout'), { killed: true }); },
  });
  assert.equal(attempts, 3);
  assert.equal(pages.length, 2);
  assert.equal(pages[1].payload.code, 'identity-check-unavailable');
});

test('watcher broker auth refuses an empty service token before any HTTP request', async () => {
  const { watcherServiceTokenForRequest } = await import('../src/github-identity-boot.mjs');
  assert.throws(() => watcherServiceTokenForRequest({ WATCHER_GH_AUTH_VIA_BROKER: 'true' }),
    error => error.authOutage === true && error.code === 'service-token-unavailable');
  assert.equal(watcherServiceTokenForRequest({ WATCHER_GH_AUTH_VIA_BROKER: 'true', GITHUB_TOKEN: 'held-fixture' }), 'held-fixture');
});
