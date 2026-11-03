// Manual qualification only; not imported by the ordinary test runner.
// Model the ambient PID collision without consulting the host process table.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const spawn = childProcess.spawn;
childProcess.spawn = function (command, args, ...rest) {
  if (args?.includes('--test')) {
    const index = args.indexOf('--test');
    args = [...args.slice(0, index),
      '--test-name-pattern=CLOSERLEASE-01: reconcile pending-live lease|REVIEWALERT-01 ownerless recovery honours|REVIEWALERT-01 a competing launch',
      ...args.slice(index)];
  }
  return spawn.call(this, command, args, ...rest);
};
const execFileSync = childProcess.execFileSync;
childProcess.execFileSync = function (command, args, ...rest) {
  if (command === 'ps' && JSON.stringify(args) === JSON.stringify(['-o', 'lstart=', '-p', '123'])) {
    return process.env.LEASECIPROOF_PS === 'present' ? 'Mon Nov  2 12:00:00 2026\n' : '';
  }
  return execFileSync.call(this, command, args, ...rest);
};
syncBuiltinESMExports();
