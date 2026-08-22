/**
 * Which processes the supervisor supervises (ARF-08).
 *
 * The set is the built-in ARF server plus whatever the config declares. Kept
 * apart from `supervisor.mjs` so the resolution — which is where the mode rule
 * lives — can be tested without spawning anything.
 *
 * ## The frontend is not a second process
 *
 * ARF's SPA is plain HTML, CSS, and ES modules with no build step, served
 * in-process by the ARF server (`server/src/static.mjs`). Supervising the
 * server therefore *is* supervising the frontend, and inventing a second
 * process to make an org chart look right would add a thing that can fail
 * without adding anything that works. A deployment that fronts the SPA with
 * something else declares it as a `frontend`-role program and gets it
 * supervised like any other child.
 *
 * ## Pipeline daemons, standalone only
 *
 * SPEC §9 puts "supervises ARF (and, standalone, pipeline daemons)" on this
 * surface. The parenthetical is a hard rule here rather than a note: in `in-os`
 * mode launchd already owns the watcher and the auto-merge daemon, and a second
 * supervisor starting its own copies would put two watchers on the same review
 * claims and the same merge lease. That is refused at resolution, with the
 * program named.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ARF_SERVER_PROGRAM_ID } from './program-config.mjs';

// src -> supervisor -> arf
const ARF_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The ARF server's entrypoint, resolved from this file rather than from cwd. */
export const ARF_SERVER_ENTRY = resolve(ARF_ROOT, 'server', 'src', 'main.mjs');

/**
 * Environment every supervised child receives on top of the supervisor's own.
 *
 * This is how a supervised pipeline daemon finds the gate with nothing else
 * configured: one variable, exported by the process that already knows where
 * ARF's state root is. A daemon started by hand outside the supervisor still
 * works — it just has to be told `ARF_GATE_FILE` itself.
 *
 * @param {object} config resolved ARF config
 * @param {string} programId
 */
export function childEnvironment(config, programId) {
  return {
    ARF_STATE_ROOT: config.stateRoot,
    ARF_GATE_FILE: config.governance.gatePath,
    ARF_GATE_AUDIT_FILE: config.governance.gateAuditPath,
    // Lets a child tell "started by the ARF supervisor" from "started by hand",
    // which is the difference between a crash being restarted and being final.
    ARF_SUPERVISED_BY: 'arf-supervisor',
    ARF_PROGRAM_ID: programId,
  };
}

export class ProgramSetError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProgramSetError';
  }
}

/**
 * Resolve the program set from the config.
 *
 * @param {object} options
 * @param {ReturnType<import('../../server/src/config.mjs').loadConfig>} options.config
 * @param {string} [options.execPath] the Node binary children are launched with.
 *   Defaults to `process.execPath` — never the string `node` — so a standalone
 *   install works with no `node` on PATH, which is exactly the situation a
 *   launchd-free boot from a bare shell is in.
 * @param {string} [options.serverEntry]
 * @returns {object[]} program specs, in start order
 */
export function resolveProgramSet({ config, execPath = process.execPath, serverEntry = ARF_SERVER_ENTRY }) {
  const programs = [];

  if (config.supervisor.serverEnabled) {
    programs.push({
      id: ARF_SERVER_PROGRAM_ID,
      role: 'arf-server',
      command: execPath,
      args: [serverEntry, ...config.supervisor.serverArgs],
      cwd: null,
      env: {},
      autoRestart: true,
      enabled: true,
      builtIn: true,
    });
  }

  for (const program of config.supervisor.programs) {
    if (!program.enabled) continue;
    if (program.role === 'pipeline' && config.mode !== 'standalone') {
      throw new ProgramSetError(
        `supervisor program "${program.id}" has role=pipeline, which is standalone-only: in `
        + `mode=${config.mode} launchd owns the pipeline daemons, and a second copy would race `
        + 'the same review claims and merge lease. Set mode=standalone or disable the program.',
      );
    }
    programs.push({ ...program, builtIn: false });
  }

  if (programs.length === 0) {
    // A supervisor with nothing to supervise would sit there looking healthy.
    throw new ProgramSetError(
      'no programs to supervise: supervisor.serverEnabled is false and supervisor.programs is empty',
    );
  }

  return programs;
}
