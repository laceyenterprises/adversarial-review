import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectAppContract } from '../src/app-contract-dispatch.mjs';
import { loadConfig } from '../src/config-loader.mjs';

const CONTROLLED_PR_REVIEW_PAYLOAD = {
  request_id: 'review-laceyenterprises__portable-app-pr-42-headabc123',
  ticket_ref: 'PORT-42',
  repo: 'laceyenterprises/portable-app',
  pr_number: 42,
  head_sha: 'abc123portable',
  worker_class: 'codex',
  task_kind: 'review',
  completion_shape: 'review-body',
  prompt: 'Review controlled fixture PR #42.',
};

function normalizeReviewDispatch(dispatch) {
  return {
    request_id: dispatch.request_id,
    repo: dispatch.repo,
    pr_number: dispatch.pr_number,
    head_sha: dispatch.head_sha,
    worker_class: dispatch.worker_class,
    task_kind: dispatch.task_kind,
    completion_shape: dispatch.completion_shape,
    prompt: dispatch.prompt,
  };
}

async function withAgentOsDispatchServer(run) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bodyText = Buffer.concat(chunks).toString('utf8');
    const body = bodyText ? JSON.parse(bodyText) : {};
    requests.push({ method: req.method, url: req.url, body });

    if (req.method === 'POST' && req.url === '/v1/register') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ session_token: 'sess_apc06_agent_os' }));
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/dispatch') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        request_id: body.request_id,
        launch_request_id: `lrq_${body.request_id}`,
        watch_url: `agent-os://watch/lrq_${body.request_id}`,
        audit_ref: `agent-os://audit/${body.request_id}`,
      }));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'not_found', message: req.url } }));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  const previous = {
    APP_CONTRACT_BOOTSTRAP_TOKEN: process.env.APP_CONTRACT_BOOTSTRAP_TOKEN,
    APP_CONTRACT_BOOTSTRAP_TOKEN_FILE: process.env.APP_CONTRACT_BOOTSTRAP_TOKEN_FILE,
    APP_CONTRACT_ENDPOINT_URL: process.env.APP_CONTRACT_ENDPOINT_URL,
  };
  process.env.APP_CONTRACT_BOOTSTRAP_TOKEN = 'bootstrap-apc06';
  delete process.env.APP_CONTRACT_BOOTSTRAP_TOKEN_FILE;
  process.env.APP_CONTRACT_ENDPOINT_URL = `http://127.0.0.1:${port}`;

  try {
    return await run({ requests });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise((resolve) => server.close(resolve));
  }
}

test('emitTopic isolates listener throws and rejections while delivering later listeners', async () => {
  const session = await connectAppContract({
    app_id: 'test.app-contract',
    mode: 'standalone',
  });
  const deliveries = [];
  const originalError = console.error;
  console.error = () => {};
  try {
    session.on('health.worker.*', () => {
      throw new Error('sync listener failed');
    });
    session.on('health.worker.*', async () => {
      throw new Error('async listener failed');
    });
    session.on('health.worker.*', (event, topic) => {
      deliveries.push({ event, topic });
      return { delivered: true };
    });

    const results = await Promise.all(session.emitTopic('health.worker.terminal.lrq_123', { status: 'succeeded' }));

    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].topic, 'health.worker.terminal.lrq_123');
    assert.equal(results.length, 3);
    assert.deepEqual(results.map((result) => result.delivered), [false, false, true]);
  } finally {
    console.error = originalError;
  }
});

test('topic wildcard matches empty suffixes', async () => {
  const session = await connectAppContract({
    app_id: 'test.app-contract',
    mode: 'standalone',
  });
  const topics = [];
  session.on('health.worker*', (_event, topic) => {
    topics.push(topic);
  });

  await Promise.all(session.emitTopic('health.worker', {}));
  await Promise.all(session.emitTopic('health.worker.', {}));
  await Promise.all(session.emitTopic('health.worker.terminal.lrq_123', {}));

  assert.deepEqual(topics, [
    'health.worker',
    'health.worker.',
    'health.worker.terminal.lrq_123',
  ]);
});

test('APC-06 standalone review dispatch runs without agent-os and matches agent-os review behavior', async () => {
  const root = mkdtempSync(join(tmpdir(), 'apc06-standalone-review-'));
  const topConfigPath = join(root, 'config.yaml');
  const standalonePayloadPath = join(root, 'standalone-dispatch.json');
  const dispatchCliPath = join(root, 'standalone-review-dispatch.mjs');
  writeFileSync(topConfigPath, 'version: 1\n', 'utf8');
  writeFileSync(dispatchCliPath, `
import { writeFileSync } from 'node:fs';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
if (process.env.HQ_ROOT || process.env.APP_CONTRACT_HQ_ROOT) {
  throw new Error('standalone fixture must not receive an agent-os root');
}
if (process.env.APP_CONTRACT_ENDPOINT_URL) {
  throw new Error('standalone fixture must not depend on the app-contract endpoint');
}
writeFileSync(${JSON.stringify(standalonePayloadPath)}, JSON.stringify(payload, null, 2));
process.stdout.write(JSON.stringify({ launch_request_id: 'standalone-lrq-controlled-pr-42' }));
`, 'utf8');

  try {
    const standaloneEnv = {
      AGENT_OS_CONFIG_PATH: topConfigPath,
      AGENT_OS_APPS_ADVERSARIAL_REVIEW_MODE: 'standalone',
      AGENT_OS_APPS_ADVERSARIAL_REVIEW_SUBSCRIBES: 'health.worker.*,token.*',
    };
    const cfg = loadConfig({ topPath: topConfigPath, modulePaths: [], env: standaloneEnv });
    assert.equal(cfg.get('apps.adversarial-review.mode'), 'standalone');
    assert.deepEqual(cfg.get('apps.adversarial-review.subscribes'), ['health.worker.*', 'token.*']);

    const agentOsPayload = await withAgentOsDispatchServer(async ({ requests }) => {
      const agentOs = await connectAppContract({
        app_id: 'adversarial-review',
        mode: 'agent-os',
        subscribes: ['health.worker.*', 'token.*'],
      });
      const accepted = await agentOs.dispatch(CONTROLLED_PR_REVIEW_PAYLOAD);
      assert.match(accepted.launch_request_id, /^lrq_review-laceyenterprises__portable-app-pr-42/);
      return requests.find((entry) => entry.url === '/v1/dispatch')?.body;
    });

    const previous = {
      HQ_ROOT: process.env.HQ_ROOT,
      APP_CONTRACT_HQ_ROOT: process.env.APP_CONTRACT_HQ_ROOT,
      APP_CONTRACT_BOOTSTRAP_TOKEN: process.env.APP_CONTRACT_BOOTSTRAP_TOKEN,
      APP_CONTRACT_BOOTSTRAP_TOKEN_FILE: process.env.APP_CONTRACT_BOOTSTRAP_TOKEN_FILE,
      APP_CONTRACT_ENDPOINT_URL: process.env.APP_CONTRACT_ENDPOINT_URL,
    };
    try {
      delete process.env.HQ_ROOT;
      delete process.env.APP_CONTRACT_HQ_ROOT;
      delete process.env.APP_CONTRACT_BOOTSTRAP_TOKEN;
      delete process.env.APP_CONTRACT_BOOTSTRAP_TOKEN_FILE;
      delete process.env.APP_CONTRACT_ENDPOINT_URL;

      const terminalEvents = [];
      const standalone = await connectAppContract({
        app_id: 'adversarial-review',
        mode: cfg.get('apps.adversarial-review.mode'),
        subscribes: cfg.get('apps.adversarial-review.subscribes'),
        dispatchCommand: [process.execPath, dispatchCliPath],
      });
      standalone.on('health.worker.terminal.*', (event, topic) => {
        terminalEvents.push({ event, topic });
      });
      const accepted = await standalone.dispatch(CONTROLLED_PR_REVIEW_PAYLOAD);
      assert.deepEqual(accepted, {
        app_id: 'adversarial-review',
        request_id: CONTROLLED_PR_REVIEW_PAYLOAD.request_id,
        launch_request_id: 'standalone-lrq-controlled-pr-42',
        watch_url: 'standalone://watch/standalone-lrq-controlled-pr-42',
        audit_ref: `standalone://audit/adversarial-review/${CONTROLLED_PR_REVIEW_PAYLOAD.request_id}`,
      });
      assert.deepEqual(terminalEvents, []);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    const standalonePayload = JSON.parse(readFileSync(standalonePayloadPath, 'utf8'));
    assert.deepEqual(
      normalizeReviewDispatch(standalonePayload),
      normalizeReviewDispatch(agentOsPayload),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('standalone dispatchStatus reports dispatching while launch is in flight', async () => {
  let resolveLaunch;
  let resolveLaunchStarted;
  const launchStarted = new Promise((resolve) => {
    resolveLaunchStarted = resolve;
  });
  const launchRelease = new Promise((resolve) => {
    resolveLaunch = resolve;
  });
  const session = await connectAppContract({
    app_id: 'test.app-contract',
    mode: 'standalone',
    standalone_dispatcher: async () => {
      resolveLaunchStarted();
      await launchRelease;
      return 'lrq_pending_then_found';
    },
  });

  const dispatchPromise = session.dispatch({ request_id: 'req-pending-status' });
  await launchStarted;

  assert.deepEqual(await session.dispatchStatus('req-pending-status'), {
    status: 'dispatching',
    app_id: 'test.app-contract',
    request_id: 'req-pending-status',
  });

  resolveLaunch();
  await dispatchPromise;
  assert.deepEqual(await session.dispatchStatus('req-pending-status'), {
    status: 'found',
    app_id: 'test.app-contract',
    request_id: 'req-pending-status',
    launch_request_id: 'lrq_pending_then_found',
    watch_url: 'standalone://watch/lrq_pending_then_found',
    audit_ref: 'standalone://audit/test.app-contract/req-pending-status',
  });
});

test('standalone dispatch command timeout rejects and clears in-flight memo entry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'apc06-dispatch-timeout-'));
  const dispatchCliPath = join(root, 'hang-dispatch.mjs');
  writeFileSync(dispatchCliPath, `
setInterval(() => {}, 1000);
`, 'utf8');

  try {
    const session = await connectAppContract({
      app_id: 'test.app-contract',
      mode: 'standalone',
      requestTimeoutMs: 50,
      dispatchCommand: [process.execPath, dispatchCliPath],
    });

    await assert.rejects(
      session.dispatch({ request_id: 'req-timeout' }),
      /standalone dispatch command timed out after 50ms/,
    );
    assert.deepEqual(await session.dispatchStatus('req-timeout'), {
      status: 'not_found',
      app_id: 'test.app-contract',
      request_id: 'req-timeout',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('standalone dispatch command spawn or stdin errors reject instead of crashing', async () => {
  const session = await connectAppContract({
    app_id: 'test.app-contract',
    mode: 'standalone',
    requestTimeoutMs: 100,
    dispatchCommand: ['definitely-missing-standalone-dispatch-command-apc06'],
  });

  await assert.rejects(
    session.dispatch({ request_id: 'req-missing-command' }),
    /ENOENT|spawn definitely-missing-standalone-dispatch-command-apc06/,
  );
  assert.deepEqual(await session.dispatchStatus('req-missing-command'), {
    status: 'not_found',
    app_id: 'test.app-contract',
    request_id: 'req-missing-command',
  });
});

test('standalone dispatch command decodes split multibyte stdout once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'apc06-dispatch-utf8-'));
  const dispatchCliPath = join(root, 'utf8-dispatch.mjs');
  writeFileSync(dispatchCliPath, `
const output = Buffer.from(JSON.stringify({ launch_request_id: 'lrq_utf8_é' }), 'utf8');
const split = output.indexOf(0xc3) + 1;
process.stdout.write(output.subarray(0, split));
setTimeout(() => process.stdout.end(output.subarray(split)), 10);
`, 'utf8');

  try {
    const session = await connectAppContract({
      app_id: 'test.app-contract',
      mode: 'standalone',
      dispatchCommand: [process.execPath, dispatchCliPath],
    });

    const accepted = await session.dispatch({ request_id: 'req-utf8' });
    assert.equal(accepted.launch_request_id, 'lrq_utf8_é');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('standalone dispatch command may ignore stdin and still resolve from stdout', async () => {
  const root = mkdtempSync(join(tmpdir(), 'apc06-dispatch-ignore-stdin-'));
  const dispatchCliPath = join(root, 'ignore-stdin-dispatch.mjs');
  writeFileSync(dispatchCliPath, `
process.stdout.write(JSON.stringify({ launch_request_id: 'lrq_ignore_stdin' }));
`, 'utf8');

  try {
    const session = await connectAppContract({
      app_id: 'test.app-contract',
      mode: 'standalone',
      dispatchCommand: [process.execPath, dispatchCliPath],
    });

    const accepted = await session.dispatch({
      request_id: 'req-ignore-stdin',
      prompt: 'x'.repeat(1024 * 1024),
    });
    assert.equal(accepted.launch_request_id, 'lrq_ignore_stdin');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('standalone dispatch command output is capped', async () => {
  const root = mkdtempSync(join(tmpdir(), 'apc06-dispatch-output-cap-'));
  const dispatchCliPath = join(root, 'output-cap-dispatch.mjs');
  writeFileSync(dispatchCliPath, `
process.stdout.write('x'.repeat(5 * 1024 * 1024));
setInterval(() => {}, 1000);
`, 'utf8');

  try {
    const session = await connectAppContract({
      app_id: 'test.app-contract',
      mode: 'standalone',
      requestTimeoutMs: 5000,
      dispatchCommand: [process.execPath, dispatchCliPath],
    });

    await assert.rejects(
      session.dispatch({ request_id: 'req-output-cap' }),
      (error) => error.retryable === true
        && /standalone dispatch command output exceeded \d+ bytes/.test(error.message),
    );
    assert.deepEqual(await session.dispatchStatus('req-output-cap'), {
      status: 'not_found',
      app_id: 'test.app-contract',
      request_id: 'req-output-cap',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('standalone accepted dispatch cache is bounded', async () => {
  const session = await connectAppContract({
    app_id: 'test.app-contract',
    mode: 'standalone',
    standaloneDispatchCacheMaxEntries: 1,
    standalone_dispatcher: (payload) => `lrq_${payload.request_id}`,
  });

  await session.dispatch({ request_id: 'req-cache-a' });
  await session.dispatch({ request_id: 'req-cache-b' });

  assert.equal((await session.dispatchStatus('req-cache-a')).status, 'not_found');
  assert.equal((await session.dispatchStatus('req-cache-b')).status, 'found');
});
