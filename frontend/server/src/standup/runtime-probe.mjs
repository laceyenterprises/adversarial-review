/**
 * Install/verify the harness runtime (ARF-06 step 3).
 *
 * "Verify the runtime is reachable" is a small job with two sharp edges.
 *
 * **Executable behavior must be server policy.** This step runs on behalf of an
 * HTTP POST. A request may name only a runtime command that the daemon config
 * allowlists; probe argv is fixed by the manifest normalizer. `execFile` avoids
 * shell parsing, and fixed argv prevents an allowed interpreter from becoming
 * `node -e` or `python3 -c` executable behavior.
 *
 * **`PATH` under a daemon is not `PATH` in a shell.** launchd hands a LaunchAgent
 * a minimal `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`), so a Homebrew-installed
 * harness CLI that an operator can run by hand is simply absent as far as the
 * daemon is concerned. Resolving the binary here — and reporting the absolute
 * path that was found — turns "the runtime is broken" into "the daemon cannot
 * see it, add its directory to standup.runtimeSearchPath", which is a different
 * afternoon.
 *
 * Installing is gated separately and defaults to off: verification is a read,
 * installation is a change to the machine, and one HTTP request should not be
 * able to make the second happen because the first failed.
 */

import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join, resolve as resolvePath } from 'node:path';

export class RuntimeProbeError extends Error {
  constructor(message, { code = 'runtime_probe', cause = undefined } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'RuntimeProbeError';
    this.code = code;
  }
}

/**
 * The version banner, as one bounded line.
 *
 * Only for the *successful* version probe, where one line is the whole answer and
 * is what `satisfiesMinVersion` reads. Failures go through `commandOutput`.
 */
function firstLine(text, limit = 200) {
  return String(text ?? '').split('\n').find((line) => line.trim() !== '')?.trim().slice(0, limit) ?? '';
}

/**
 * Everything the subprocess said, as a bounded multi-line diagnostic.
 *
 * Keeping the first line of a *failure* keeps the least useful line. A tool that
 * fails prints a header and then the reason underneath it — `npm ERR! code E404`
 * on line one and the package it could not find three lines down, or a stack
 * whose top frame is the thrower and whose bottom frame is the cause. An
 * operator reading the wizard's failed step needs the lines below the first one,
 * so all of them survive; only blank lines are dropped.
 *
 * The bound is on the whole text rather than per line, and it announces itself
 * when it bites: a cap that silently drops the tail reads as complete output
 * that simply never explained itself, which is the failure mode this helper
 * exists to avoid.
 */
function commandOutput(text, limit = 4000) {
  const joined = String(text ?? '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '')
    .join('\n')
    .trim();
  if (joined.length <= limit) return joined;
  return `${joined.slice(0, limit)}\n[output truncated at ${limit} of ${joined.length} characters]`;
}

function runCommand(command, args, { timeoutMs, execFileImpl, env }) {
  return new Promise((resolve) => {
    execFileImpl(
      command,
      args,
      { timeout: timeoutMs, maxBuffer: 512 * 1024, encoding: 'utf8', env },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({ ok: true, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
          return;
        }
        resolve({
          ok: false,
          error: err,
          // A tool that prints its version to stderr (several do) still told us
          // what we asked, so both streams come back either way.
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          // A timeout kill and a non-zero exit are different answers: the first
          // means the runtime never responded, the second that it responded no.
          killed: err.killed === true || typeof err.signal === 'string',
          exitCode: typeof err.code === 'number' ? err.code : null,
          spawnCode: typeof err.code === 'string' ? err.code : null,
        });
      },
    );
  });
}

const INSTALL_RETRY_DELAYS_MS = Object.freeze([250, 1000]);
const TRANSIENT_INSTALL_PATTERNS = Object.freeze([
  /\bEAI_AGAIN\b/i,
  /\bECONNRESET\b/i,
  /\bETIMEDOUT\b/i,
  /\bECONNREFUSED\b/i,
  /\bENETUNREACH\b/i,
  /\bEHOSTUNREACH\b/i,
  /\bTLS handshake timeout\b/i,
  /\bnetwork timeout\b/i,
  /\bresource temporarily unavailable\b/i,
  /\btemporary failure\b/i,
  /\bHTTP (?:5\d\d|429)\b/i,
  /\b(?:status|code)[ =:]+(?:5\d\d|429)\b/i,
]);

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function isTransientInstallFailure(result) {
  const text = [
    result.spawnCode,
    result.error?.code,
    result.error?.message,
    result.stderr,
    result.stdout,
  ].filter(Boolean).join('\n');
  return TRANSIENT_INSTALL_PATTERNS.some((pattern) => pattern.test(text));
}

async function runInstallCommand(command, args, {
  timeoutMs, execFileImpl, env, sleepImpl = sleep,
}) {
  for (let attempt = 0; ; attempt += 1) {
    const result = await runCommand(command, args, { timeoutMs, execFileImpl, env });
    if (result.ok) return { ...result, attempts: attempt + 1 };
    if (attempt >= INSTALL_RETRY_DELAYS_MS.length || !isTransientInstallFailure(result)) {
      return { ...result, attempts: attempt + 1 };
    }
    await sleepImpl(INSTALL_RETRY_DELAYS_MS[attempt]);
  }
}

/**
 * Find an executable, searching `runtimeSearchPath` before `PATH`.
 *
 * An absolute command is used as given (and checked). A bare name is resolved
 * here rather than left to `execFile`, so the step can report *which* binary it
 * probed — two `claude` binaries on one machine is not an exotic situation.
 *
 * @returns {Promise<string|null>} absolute path, or null when nothing was found
 */
export async function resolveExecutable(command, { searchPath = [], env = process.env } = {}) {
  const executable = async (candidate) => {
    try {
      const info = await stat(candidate);
      if (!info.isFile()) return false;
      await access(candidate, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  };

  if (command.includes('/')) {
    const absolute = isAbsolute(command) ? command : resolvePath(command);
    return (await executable(absolute)) ? absolute : null;
  }

  const dirs = [...searchPath, ...String(env.PATH ?? '').split(delimiter)].filter(Boolean);
  for (const dir of dirs) {
    const candidate = join(dir, command);
    if (await executable(candidate)) return candidate;
  }
  return null;
}

/**
 * Probe (and optionally install) a harness runtime.
 *
 * @param {object} options
 * @param {{command: string, versionArgs: string[], installCommand: string|null,
 *          installArgs: string[], minVersion: string|null}} options.runtime
 * @param {string[]} options.allowlist  commands this daemon may execute
 * @param {string[]} [options.searchPath] extra directories to search first
 * @param {boolean} [options.allowInstall] operator gate for the install command
 * @param {number} [options.timeoutMs]
 * @param {Function} [options.execFileImpl] injection point for tests
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {boolean} [options.dryRun]
 * @param {Function} [options.sleepImpl] injection point for retry tests
 * @returns {Promise<object>} the runtime record for the manifest
 */
export async function probeRuntime({
  runtime,
  allowlist,
  searchPath = [],
  allowInstall = false,
  timeoutMs = 15000,
  execFileImpl = execFile,
  env = process.env,
  dryRun = false,
  sleepImpl = sleep,
}) {
  if (!runtime) {
    // A harness with no runtime declared is legitimate — an in-OS class whose
    // runtime the OS already owns — and saying so is better than inventing a
    // probe that trivially passes.
    return { declared: false, verified: false, reason: 'no runtime declared for this harness' };
  }

  const allowed = new Set(allowlist);
  const assertAllowed = (command, what) => {
    if (allowed.has(command)) return;
    throw new RuntimeProbeError(
      `${what} ${JSON.stringify(command)} is not in standup.runtimeCommandAllowlist `
      + `(${[...allowed].join(', ')}). ARF executes only commands an operator has allowed in `
      + 'config — a standup request cannot introduce one.',
      { code: 'runtime_command_refused' },
    );
  };
  assertAllowed(runtime.command, 'runtime.command');
  if (runtime.installCommand) assertAllowed(runtime.installCommand, 'runtime.installCommand');

  if (dryRun) {
    const resolved = await resolveExecutable(runtime.command, { searchPath, env });
    return {
      declared: true,
      verified: false,
      dryRun: true,
      command: runtime.command,
      resolvedPath: resolved,
      version: null,
      installed: false,
      reason: resolved
        ? 'dry run: the runtime was found but not executed'
        : 'dry run: the runtime was not found on ARF\'s search path',
    };
  }

  let resolved = await resolveExecutable(runtime.command, { searchPath, env });
  let installed = false;

  if (!resolved && runtime.installCommand) {
    if (!allowInstall) {
      throw new RuntimeProbeError(
        `${runtime.command} is not installed and standup.allowRuntimeInstall is false, so ARF `
        + `will not run ${JSON.stringify(runtime.installCommand)}. Install the runtime out of `
        + 'band, or set standup.allowRuntimeInstall in ARF config.',
        { code: 'runtime_install_gated' },
      );
    }
    // The installer is resolved the same way the runtime is, and for the same
    // reason: under launchd's minimal PATH a Homebrew `npm` or `brew` is as
    // invisible as the runtime it would install, and handing `execFile` a bare
    // name would surface that as a bare ENOENT instead of the one sentence that
    // fixes it. Resolving here also means the error names the installer ARF
    // would have run, rather than the one the operator has in their shell.
    const installExecutable = await resolveExecutable(runtime.installCommand, { searchPath, env });
    if (!installExecutable) {
      throw new RuntimeProbeError(
        `${runtime.command} is not installed and its installer `
        + `${JSON.stringify(runtime.installCommand)} was not found on ARF's search path`
        + `${searchPath.length ? ` (${searchPath.join(', ')} then PATH)` : ' (PATH)'}. `
        + 'A background service inherits a minimal PATH, so an installer that runs fine in a '
        + 'shell can be invisible here — add its directory to standup.runtimeSearchPath.',
        { code: 'runtime_installer_not_found' },
      );
    }
    const install = await runInstallCommand(installExecutable, runtime.installArgs, {
      timeoutMs, execFileImpl, env, sleepImpl,
    });
    if (!install.ok) {
      // An installer that fails is not reliably a stderr citizen — a shell script
      // can print its reason to stdout and just exit non-zero — so stdout is read
      // rather than letting an empty stderr collapse this to "Command failed".
      const detail = commandOutput(install.stderr) || commandOutput(install.stdout)
        || install.error?.message || 'unknown error';
      throw new RuntimeProbeError(
        `installing ${runtime.command} via ${installExecutable} failed: ${detail}`,
        { code: 'runtime_install_failed' },
      );
    }
    installed = true;
    resolved = await resolveExecutable(runtime.command, { searchPath, env });
  }

  if (!resolved) {
    throw new RuntimeProbeError(
      `${runtime.command} was not found on ARF's search path`
      + `${searchPath.length ? ` (${searchPath.join(', ')} then PATH)` : ' (PATH)'}. `
      + 'A background service inherits a minimal PATH, so a runtime that runs fine in a shell '
      + 'can be invisible here — add its directory to standup.runtimeSearchPath.',
      { code: 'runtime_not_found' },
    );
  }

  const probe = await runCommand(resolved, runtime.versionArgs, { timeoutMs, execFileImpl, env });
  if (!probe.ok) {
    const output = commandOutput(probe.stderr) || commandOutput(probe.stdout);
    // On a kill, only what the runtime itself said is worth appending — Node's
    // own "Command failed" adds nothing to a sentence that already says it timed
    // out. But a runtime that hangs usually says why before it does ("waiting for
    // browser login…"), and that line is the difference between "unresponsive"
    // and a fixable auth problem, so it is not dropped.
    const detail = probe.killed ? output : (output || probe.error?.message || '');
    throw new RuntimeProbeError(
      (probe.killed
        ? `${resolved} did not respond to ${runtime.versionArgs.join(' ')} within ${timeoutMs}ms`
        : `${resolved} ${runtime.versionArgs.join(' ')} exited ${probe.exitCode ?? probe.spawnCode}`)
      + `${detail ? `: ${detail}` : ''}`,
      { code: probe.killed ? 'runtime_unresponsive' : 'runtime_unhealthy' },
    );
  }

  const version = firstLine(probe.stdout) || firstLine(probe.stderr) || null;
  if (runtime.minVersion && version && !satisfiesMinVersion(version, runtime.minVersion)) {
    throw new RuntimeProbeError(
      `${resolved} reports ${JSON.stringify(version)}, below the declared minimum `
      + `${runtime.minVersion}`,
      { code: 'runtime_too_old' },
    );
  }

  return {
    declared: true,
    verified: true,
    dryRun: false,
    command: runtime.command,
    resolvedPath: resolved,
    version,
    installed,
    reason: null,
  };
}

/**
 * Compare a reported version string against a declared minimum.
 *
 * Deliberately narrow: it reads the first dotted-numeric run out of whatever the
 * tool printed ("claude 1.4.2 (build 9)") and compares component-wise. A version
 * string with no numeric run at all returns `true` rather than failing the step
 * — refusing a runtime because ARF could not parse its banner would be ARF's
 * problem presented as the operator's.
 */
export function satisfiesMinVersion(reported, minimum) {
  const parse = (text) => {
    const match = String(text).match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
    return match ? [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)] : null;
  };
  const got = parse(reported);
  const want = parse(minimum);
  if (!got || !want) return true;
  for (let i = 0; i < 3; i += 1) {
    if (got[i] > want[i]) return true;
    if (got[i] < want[i]) return false;
  }
  return true;
}
