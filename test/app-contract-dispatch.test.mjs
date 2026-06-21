import test from 'node:test';
import assert from 'node:assert/strict';
import { connectAppContract } from '../src/app-contract-dispatch.mjs';

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
