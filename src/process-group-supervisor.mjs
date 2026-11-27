import { spawn } from 'node:child_process';

// This process is the detached session leader. Only it signals the group,
// while its own PID still pins the group ID. It remains alive after the
// command exits so the caller can finish an already armed TERM grace period.
function signalGroup(signal) {
  process.kill(-process.pid, signal);
}

process.on('SIGTERM', () => {});
process.once('disconnect', () => signalGroup('SIGKILL'));

let started = false;
process.on('message', ({ signal, start }) => {
  if (signal) {
    signalGroup(signal);
    return;
  }
  if (!start || started) return;
  started = true;
  const { command, args, env, relayMessages } = start;
  const send = message => process.send(message, () => {});
  const commandChild = spawn(command, args, {
    env,
    stdio: ['inherit', 'inherit', 'inherit', ...(relayMessages ? ['ipc'] : [])],
  });
  if (relayMessages) commandChild.on('message', payload => send({ type: 'message', payload }));
  commandChild.once('exit', (code, signal) => send({ type: 'exit', code, signal }));
  commandChild.once('error', error => send({ type: 'error', message: error.message, code: error.code }));
});
