import test from 'node:test';
import assert from 'node:assert/strict';
import { alertPresentationForDoc } from '../src/alert-delivery.mjs';
import { checkReviewServiceIdentityAtBoot } from '../src/github-identity-boot.mjs';

const bin = '/fixture/github-adapter';
const quiet = { error() {}, warn() {} };

for (const service of ['watcher', 'follow-up']) {
  test(`${service} pages once per failed role and owner, then continues startup`, async () => {
    const pages = [];
    const failure = { role: 'merge-agent', owner: 'rundix', ok: false, code: 'github-app-owner-not-configured' };
    const env = { GHA_ADAPTER_BIN: bin, CODEX_REVIEWER_AUTH_VIA_BROKER: 'true', GH_TOKEN: 'ambient-fixture' };
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
  const ok = await checkReviewServiceIdentityAtBoot('watcher', { env: { GHA_ADAPTER_BIN: bin }, log: quiet,
    deliverAlertImpl: () => assert.fail('healthy boots must not page'),
    execFileImpl: async () => ({ stdout: JSON.stringify({ ok: true, checks: [
      { role: 'merge-agent', owner: 'fixture-org', ok: true, code: 'ok' },
      { role: 'merge-agent', owner: 'rundix', ok: true, code: 'ok' },
    ] }) }),
  });
  assert.equal(ok, true);
});
