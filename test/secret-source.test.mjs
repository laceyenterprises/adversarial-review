import test from 'node:test';
import assert from 'node:assert/strict';

import { parseDotenv } from '../src/secret-source/dotenv.mjs';
import { OAUTH_ENV_STRIP_LIST, injectEnvSecrets, scrubOAuthFallbackEnv } from '../src/secret-source/env.mjs';
import {
  formatResolveOpTokenDiagnostic,
  resolveOpToken,
} from '../src/secret-source/op.mjs';

function makeFsStub(fileMap) {
  return (path) => {
    if (!Object.prototype.hasOwnProperty.call(fileMap, path)) {
      const err = new Error(`ENOENT: no such file or directory, open '${path}'`);
      err.code = 'ENOENT';
      throw err;
    }
    return fileMap[path];
  };
}

test('secret-source scrub list removes provider fallback env while preserving Anthropic OAuth bearer', () => {
  const { env, stripped } = scrubOAuthFallbackEnv({
    ANTHROPIC_API_KEY: 'sk-ant',
    ANTHROPIC_AUTH_TOKEN: 'oauth-token',
    OPENAI_API_KEY: 'sk-openai',
    GEMINI_API_KEY: 'gemini',
    SAFE_VALUE: 'kept',
  });

  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.GEMINI_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'oauth-token');
  assert.equal(env.SAFE_VALUE, 'kept');
  assert.deepEqual(stripped.sort(), ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'OPENAI_API_KEY'].sort());
  assert.ok(OAUTH_ENV_STRIP_LIST.includes('AWS_BEARER_TOKEN_BEDROCK'));
});

test('injectEnvSecrets applies values after OAuth fallback scrub', () => {
  const { env, source } = injectEnvSecrets({
    env: {
      OPENAI_API_KEY: 'sk-openai',
      EXISTING: 'one',
    },
    values: {
      GITHUB_TOKEN: 'gh-token',
    },
  });

  assert.equal(source, 'env');
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.EXISTING, 'one');
  assert.equal(env.GITHUB_TOKEN, 'gh-token');
});

test('resolveOpToken returns env token directly when OP_SERVICE_ACCOUNT_TOKEN is set', () => {
  const result = resolveOpToken({
    env: { OP_SERVICE_ACCOUNT_TOKEN: '  ops_eyJfromenv\n' },
    readFileSyncImpl: () => { throw new Error('should not read'); },
    homedirImpl: () => '/home/test',
  });
  assert.equal(result.ok, true);
  assert.equal(result.token, 'ops_eyJfromenv');
  assert.equal(result.source, 'env:OP_SERVICE_ACCOUNT_TOKEN');
  assert.equal(result.checked[0].status, 'used');
});

test('resolveOpToken reads ADV_OP_TOKEN_FILE before falling back', () => {
  const fileMap = { '/etc/adv/token': 'ops_eyJfromfile\n' };
  const result = resolveOpToken({
    env: { ADV_OP_TOKEN_FILE: '/etc/adv/token' },
    readFileSyncImpl: makeFsStub(fileMap),
    homedirImpl: () => '/home/test',
  });
  assert.equal(result.ok, true);
  assert.equal(result.token, 'ops_eyJfromfile');
  assert.equal(result.source, 'ADV_OP_TOKEN_FILE');
  assert.equal(result.path, '/etc/adv/token');
});

test('resolveOpToken parses ADV_OP_TOKEN_ENV_FILE shell-style env file', () => {
  const fileMap = {
    '/etc/adv/op.env': '# header\nOP_SERVICE_ACCOUNT_TOKEN="ops_eyJfromenvfile"\nUNRELATED=keep\n',
  };
  const result = resolveOpToken({
    env: { ADV_OP_TOKEN_ENV_FILE: '/etc/adv/op.env' },
    readFileSyncImpl: makeFsStub(fileMap),
    homedirImpl: () => '/home/test',
  });
  assert.equal(result.ok, true);
  assert.equal(result.token, 'ops_eyJfromenvfile');
  assert.equal(result.source, 'ADV_OP_TOKEN_ENV_FILE');
});

test('resolveOpToken accepts export syntax in ADV_OP_TOKEN_ENV_FILE', () => {
  const fileMap = {
    '/etc/adv/op.env': 'export OP_SERVICE_ACCOUNT_TOKEN=ops_eyJexported\n',
  };
  const result = resolveOpToken({
    env: { ADV_OP_TOKEN_ENV_FILE: '/etc/adv/op.env' },
    readFileSyncImpl: makeFsStub(fileMap),
    homedirImpl: () => '/home/test',
  });
  assert.equal(result.ok, true);
  assert.equal(result.token, 'ops_eyJexported');
  assert.equal(result.source, 'ADV_OP_TOKEN_ENV_FILE');
});

test('resolveOpToken falls back to legacy op-service-account.env under $HOME/agent-os', () => {
  const home = '/home/operator';
  const legacyPath = `${home}/agent-os/agents/clio/credentials/local/op-service-account.env`;
  const fileMap = {
    [legacyPath]: 'export OP_SERVICE_ACCOUNT_TOKEN=ops_eyJlegacy\n',
  };
  const result = resolveOpToken({
    env: { HOME: home },
    readFileSyncImpl: makeFsStub(fileMap),
    homedirImpl: () => home,
  });
  assert.equal(result.ok, true);
  assert.equal(result.token, 'ops_eyJlegacy');
  assert.equal(result.source, 'legacy-env-file');
  assert.equal(result.path, legacyPath);
});

test('resolveOpToken prefers $AGENT_OS_ROOT legacy env file when set', () => {
  const home = '/home/operator';
  const agentOsRoot = '/srv/agent-os';
  const legacyPath = `${agentOsRoot}/agents/clio/credentials/local/op-service-account.env`;
  const fileMap = {
    [legacyPath]: 'OP_SERVICE_ACCOUNT_TOKEN=ops_eyJagentroot\n',
  };
  const result = resolveOpToken({
    env: { HOME: home, AGENT_OS_ROOT: agentOsRoot },
    readFileSyncImpl: makeFsStub(fileMap),
    homedirImpl: () => home,
  });
  assert.equal(result.ok, true);
  assert.equal(result.token, 'ops_eyJagentroot');
  assert.equal(result.source, 'legacy-env-file');
  assert.equal(result.path, legacyPath);
});

test('resolveOpToken falls back to ADV_SECRETS_ROOT default path', () => {
  const fileMap = { '/var/secrets/op-service-account.token': 'ops_eyJfromroot\n' };
  const result = resolveOpToken({
    env: { ADV_SECRETS_ROOT: '/var/secrets' },
    readFileSyncImpl: makeFsStub(fileMap),
    homedirImpl: () => '/home/test',
  });
  assert.equal(result.ok, true);
  assert.equal(result.token, 'ops_eyJfromroot');
  assert.equal(result.source, 'default');
  assert.equal(result.path, '/var/secrets/op-service-account.token');
});

test('resolveOpToken falls back to $HOME default path when ADV_SECRETS_ROOT unset', () => {
  const home = '/home/operator';
  const defaultPath = `${home}/.config/adversarial-review/secrets/op-service-account.token`;
  const fileMap = { [defaultPath]: 'ops_eyJfromhome\n' };
  const result = resolveOpToken({
    env: {},
    readFileSyncImpl: makeFsStub(fileMap),
    homedirImpl: () => home,
  });
  assert.equal(result.ok, true);
  assert.equal(result.token, 'ops_eyJfromhome');
  assert.equal(result.path, defaultPath);
});

test('resolveOpToken treats whitespace-only env value as missing and falls through', () => {
  const fileMap = { '/home/test/.config/adversarial-review/secrets/op-service-account.token': 'ops_eyJfallthrough\n' };
  const result = resolveOpToken({
    env: { OP_SERVICE_ACCOUNT_TOKEN: '   \n  ' },
    readFileSyncImpl: makeFsStub(fileMap),
    homedirImpl: () => '/home/test',
  });
  assert.equal(result.ok, true);
  assert.equal(result.token, 'ops_eyJfallthrough');
  assert.equal(result.checked[0].status, 'not set');
});

test('resolveOpToken reports an empty token file and continues to next source', () => {
  const fileMap = {
    '/etc/adv/empty.token': '   \n',
    '/etc/adv/full.env': 'OP_SERVICE_ACCOUNT_TOKEN=ops_eyJfromenvfile2\n',
  };
  const result = resolveOpToken({
    env: {
      ADV_OP_TOKEN_FILE: '/etc/adv/empty.token',
      ADV_OP_TOKEN_ENV_FILE: '/etc/adv/full.env',
    },
    readFileSyncImpl: makeFsStub(fileMap),
    homedirImpl: () => '/home/test',
  });
  assert.equal(result.ok, true);
  assert.equal(result.source, 'ADV_OP_TOKEN_ENV_FILE');
  const emptyFileEntry = result.checked.find((c) => c.source.includes('/etc/adv/empty.token'));
  assert.equal(emptyFileEntry.status, 'file empty after trim');
});

test('resolveOpToken reports malformed env file (missing OP_SERVICE_ACCOUNT_TOKEN key) and falls through', () => {
  const home = '/home/operator';
  const defaultPath = `${home}/.config/adversarial-review/secrets/op-service-account.token`;
  const fileMap = {
    '/etc/adv/broken.env': 'OTHER=value\n# no OP_SERVICE_ACCOUNT_TOKEN here\n',
    [defaultPath]: 'ops_eyJrecovered\n',
  };
  const result = resolveOpToken({
    env: { ADV_OP_TOKEN_ENV_FILE: '/etc/adv/broken.env' },
    readFileSyncImpl: makeFsStub(fileMap),
    homedirImpl: () => home,
  });
  assert.equal(result.ok, true);
  assert.equal(result.token, 'ops_eyJrecovered');
  const brokenEntry = result.checked.find((c) => c.source.includes('/etc/adv/broken.env'));
  assert.match(brokenEntry.status, /OP_SERVICE_ACCOUNT_TOKEN key missing or empty/);
});

test('resolveOpToken returns ok=false with full source list when every rung fails', () => {
  const result = resolveOpToken({
    env: {
      ADV_OP_TOKEN_FILE: '/no/such/file',
      ADV_OP_TOKEN_ENV_FILE: '/no/such/env',
      ADV_SECRETS_ROOT: '/no/such/root',
    },
    readFileSyncImpl: makeFsStub({}),
    homedirImpl: () => '/home/test',
  });
  assert.equal(result.ok, false);
  assert.ok(result.error);
  assert.equal(result.fallback.path, '/no/such/root/op-service-account.token');
  const sources = result.checked.map((c) => c.source);
  assert.ok(sources.some((s) => s.startsWith('env:OP_SERVICE_ACCOUNT_TOKEN')));
  assert.ok(sources.some((s) => s.startsWith('ADV_OP_TOKEN_FILE=')));
  assert.ok(sources.some((s) => s.startsWith('ADV_OP_TOKEN_ENV_FILE=')));
  assert.ok(sources.some((s) => s.startsWith('legacy env file')));
  assert.ok(sources.some((s) => s.startsWith('default token file')));
  for (const entry of result.checked) {
    if (entry.source === 'env:OP_SERVICE_ACCOUNT_TOKEN') {
      assert.equal(entry.status, 'not set');
    } else if (entry.source.startsWith('ADV_OP_TOKEN_FILE=')) {
      assert.match(entry.status, /file does not exist/);
    }
  }
});

test('formatResolveOpTokenDiagnostic includes sources, recommendations, and default path', () => {
  const result = resolveOpToken({
    env: {},
    readFileSyncImpl: makeFsStub({}),
    homedirImpl: () => '/home/test',
  });
  const text = formatResolveOpTokenDiagnostic(result, { tag: 'adversarial-watcher' });
  assert.match(text, /\[adversarial-watcher\] FATAL: could not resolve OP_SERVICE_ACCOUNT_TOKEN/);
  assert.match(text, /Sources checked, in declared precedence:/);
  assert.match(text, /env:OP_SERVICE_ACCOUNT_TOKEN/);
  assert.match(text, /env:ADV_OP_TOKEN_FILE/);
  assert.match(text, /env:ADV_OP_TOKEN_ENV_FILE/);
  assert.match(text, /legacy env file/);
  assert.match(text, /default token file/);
  assert.match(text, /Recommended fix/);
  assert.match(text, /export ADV_OP_TOKEN_FILE=/);
  assert.match(text, /\$HOME\/agent-os\/agents\/clio\/credentials\/local\/op-service-account\.env/);
  assert.match(text, /\/home\/test\/\.config\/adversarial-review\/secrets\/op-service-account\.token/);
  assert.match(text, /tools\/adversarial-review\/DEPS\.md/);
});

test('parseDotenv reads simple quoted and unquoted assignments', () => {
  assert.deepEqual(parseDotenv(`
# comment
GITHUB_TOKEN=gh-token
ALERT_TO="123456"
EMPTY=
`), {
    GITHUB_TOKEN: 'gh-token',
    ALERT_TO: '123456',
    EMPTY: '',
  });
});

test('parseDotenv accepts export-prefixed shell assignments', () => {
  assert.deepEqual(parseDotenv(`
export OP_SERVICE_ACCOUNT_TOKEN=ops_eyJshell
 export OTHER_VALUE="two"
`), {
    OP_SERVICE_ACCOUNT_TOKEN: 'ops_eyJshell',
    OTHER_VALUE: 'two',
  });
});
