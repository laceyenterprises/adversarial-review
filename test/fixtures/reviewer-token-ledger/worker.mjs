import { existsSync } from 'node:fs';
process.once('message', args => {
  if (args.action === 'error') { process.send({ ok: false, error: 'synthetic reader failure' }, () => process.exit(0)); return; }
  if (args.action === 'reply') { process.send({ ok: true, usage: { input: 7 } }, () => process.exit(0)); return; }
  if (args.action === 'exit') process.exit(3);
  if (args.action === 'timeout') { setInterval(() => {}, 1000); return; }
  process.send({ kind: 'ready' });
  const signal = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(args.releasePath)) Atomics.wait(signal, 0, 0, 10);
  process.send({ ok: true, usage: { input: 7 } }, () => process.exit(0));
});
