/**
 * Durable standup run records — what makes a re-run a resume (ARF-05).
 *
 * One JSON file per role under `<stateRoot>/standup/identity/<role>.json`. The
 * state root is ARF's own directory in both modes, so this works unchanged
 * against a live pipeline whose `reviews.db` ARF may only read.
 *
 * ## Why a fingerprint per step, and not just a status
 *
 * "Resume from the last completed step" is only honest if the completed step was
 * completed *for the inputs this run is using*. An operator who re-runs after
 * correcting a typo'd `appId` would otherwise be shown `Create / select GitHub
 * App ✔` — a claim about an App nobody is standing up any more — and the run
 * would wire the corrected role to coordinates captured from the wrong one.
 *
 * So each step records a fingerprint over the inputs it actually consumed, and a
 * recorded step is replayed only when that fingerprint still matches. Change an
 * input and the step that consumed it re-runs, along with everything after it.
 *
 * ## Why the write is atomic
 *
 * The record is written after every step, so that a crash — or an operator
 * closing the tab mid-run — still leaves a resumable prefix rather than nothing.
 * That makes a partially-written file a live risk rather than a theoretical one:
 * a truncated JSON record read by the next run would either throw at boot or, if
 * it happened to parse, describe a run that never occurred. Write-temp-then-
 * rename means a reader sees either the previous record or the new one.
 *
 * ## What is never in here
 *
 * Secret *values*. The record holds refs, GitHub coordinates, fingerprints, and
 * timestamps. `persistableParams` builds the params half from an allowlist, and
 * params validation has already refused anything that is not a reference — so
 * there is no path by which material reaches this file.
 */

import { createHash } from 'node:crypto';
import {
  mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { isValidRoleName } from '../broker/manifest.mjs';
import { tempPathFor } from './atomic-file.mjs';
import { StandupParamsError } from './errors.mjs';

/** Bumped when the record shape changes; an older record is ignored, not migrated. */
export const RECORD_SCHEMA_VERSION = 1;

const RUN_DIR_SEGMENTS = ['standup', 'identity'];

/**
 * A stable fingerprint over a step's declared inputs.
 *
 * Truncated because it is compared, never inverted, and it is rendered in the
 * record where an operator may read it. `null` and `undefined` are distinguished
 * from the string `"null"` by going through JSON.
 */
export function fingerprintInputs(inputs) {
  return createHash('sha256')
    .update(JSON.stringify(inputs ?? null), 'utf8')
    .digest('hex')
    .slice(0, 16);
}

function runFileName(role) {
  // Belt and braces over the manifest's own rule: the role name becomes a path
  // segment, and the pattern already excludes `/`, `\`, and a leading `.`, so
  // `..` and absolute paths are unspellable. Checked again here because this is
  // the module that does the filesystem write.
  if (!isValidRoleName(role)) {
    throw new StandupParamsError(`role ${JSON.stringify(role)} is not a valid role name`);
  }
  return `${role}.json`;
}

/**
 * Open the run-record store for a config.
 *
 * @param {{stateRoot: string}} config
 * @returns {{dir: string, path: (role: string) => string, read: Function,
 *   write: Function, remove: Function, list: Function}}
 */
export function openStandupRunStore(config) {
  const dir = join(config.stateRoot, ...RUN_DIR_SEGMENTS);

  const path = (role) => join(dir, runFileName(role));

  return {
    dir,
    path,

    /**
     * The recorded run for a role, or null.
     *
     * Never throws for a record that is absent, unreadable, malformed, or from a
     * schema this build does not know: all of those mean "there is nothing to
     * resume from", and the correct response is a fresh run, not a 500 on a
     * wizard the operator is trying to use to fix something.
     */
    read(role) {
      let raw;
      try {
        raw = readFileSync(path(role), 'utf8');
      } catch {
        return null;
      }
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return null;
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      if (parsed.schemaVersion !== RECORD_SCHEMA_VERSION) return null;
      if (parsed.role !== role) return null;
      if (parsed.steps === null || typeof parsed.steps !== 'object') return null;
      return parsed;
    },

    /** Persist a record atomically. Returns the record it wrote. */
    write(record) {
      mkdirSync(dir, { recursive: true });
      const target = path(record.role);
      // Beside the target and uniquely named — see `atomic-file.mjs` for why the
      // rename must be same-device and why a pid alone does not make a scratch
      // path unique.
      const temp = tempPathFor(target);
      try {
        writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
        renameSync(temp, target);
      } catch (err) {
        try {
          unlinkSync(temp);
        } catch {
          // The temp file may never have been created; nothing to clean up.
        }
        throw err;
      }
      return record;
    },

    /** Drop a role's record, so the next run starts from step 1. */
    remove(role) {
      try {
        unlinkSync(path(role));
        return true;
      } catch {
        return false;
      }
    },

    /** Every recorded run, for the panel's role list. Absent directory is empty. */
    list() {
      let entries;
      try {
        entries = readdirSync(dir);
      } catch {
        return [];
      }
      const records = [];
      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        const record = this.read(entry.slice(0, -'.json'.length));
        if (record) records.push(record);
      }
      return records;
    },
  };
}

/**
 * Whether a recorded step can stand in for running it again.
 *
 * Three conditions, all required: the step succeeded, it succeeded for these
 * exact inputs, and the step is one whose success is a durable fact about the
 * world rather than a live claim (see `alwaysRun` in `steps.mjs`).
 */
export function isReplayable(step, recorded, fingerprint) {
  if (step.alwaysRun) return false;
  if (!recorded || recorded.status !== 'ok') return false;
  return recorded.fingerprint === fingerprint;
}
