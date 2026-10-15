import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The fake live root is deliberately outside the fixture's owned data root.
// Never inspect or mutate the host's actual follow-up workspace directory.
export function createIdentityBaselineFixture(t) {
  const container = mkdtempSync(join(tmpdir(), 'identity-fixture-'));
  const rootDir = join(container, 'test-root');
  const workspaceRootDir = join(rootDir, 'workspaces');
  const fakeLiveRoot = join(container, 'fake-live');
  const liveWorkspaces = join(fakeLiveRoot, 'adversarial-review', 'follow-up-workspaces');
  mkdirSync(workspaceRootDir, { recursive: true });
  mkdirSync(join(liveWorkspaces, 'sentinel'), { recursive: true });
  const before = readdirSync(liveWorkspaces, { recursive: true }).sort();
  const assertNoLiveWrites = () => assert.deepEqual(
    readdirSync(liveWorkspaces, { recursive: true }).sort(), before,
    'identity fixture wrote outside its temporary root into fake live workspaces',
  );
  const env = {
    HQ_ROOT: fakeLiveRoot,
    AGENT_OS_DEPLOY_CHECKOUT: join(container, 'fake-deploy'),
    ADVERSARIAL_REVIEW_STATE_DIR: join(rootDir, 'data'),
    GHO_RATE_LIMIT_SHARED_STATE_PATH: join(rootDir, 'data', 'rate-limit-state.json'),
  };
  const previous = Object.fromEntries([
    ...Object.keys(env), 'ADVERSARIAL_REMEDIATION_WORKSPACE_ROOT',
  ].map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  // Workspace tests pass an explicit caller root. An unintended fallback must
  // reach the monitored HQ root, even when the host exports a workspace override.
  delete process.env.ADVERSARIAL_REMEDIATION_WORKSPACE_ROOT;
  t.after(() => {
    try {
      assertNoLiveWrites();
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(container, { recursive: true, force: true });
    }
  });
  return { rootDir, workspaceRootDir, env, fakeLiveRoot, liveWorkspaces, assertNoLiveWrites };
}
