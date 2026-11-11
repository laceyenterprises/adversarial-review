// The validator and controller exercise their real argv parsing. Their external
// canonical validation/census programs are synthetic, like the controller tests'
// snapshotImpl: only the exact child PID requested by this fixture is observed.
import { createInterface } from 'node:readline';
const args = process.argv.slice(2);
if (args[0] === 'scripts/ci-mirror/run-ci-mirror.py' && args[1] === '--'
    && args.at(-1) === 'tests/test_endpoints.py') {
  console.log('synthetic canonical validation passed');
} else if (args[0] === '-I' && args[1] === '-B' && args[2]?.endsWith('/controller_process_census.py')) {
  const answer = (verb, rawPid) => {
    const pid = Number(rawPid);
    if (!Number.isSafeInteger(pid) || pid <= 1) throw Error('invalid fixture PID');
    if (verb === 'pgid') return pid;
    if (verb !== 'group') throw Error('unexpected fixture census verb');
    try { process.kill(pid, 0); return [{ pid, birth: '1.000001' }]; }
    catch { return []; }
  };
  if (args[3] === 'serve') {
    for await (const line of createInterface({ input: process.stdin })) {
      console.log(JSON.stringify({ ok: answer(...line.split(' ')) }));
    }
  } else console.log(JSON.stringify(answer(args[3], args[4])));
} else throw Error(`unexpected fixture Python invocation: ${JSON.stringify(args)}`);
