import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';

export class ValidationSelectionError extends Error {}
export class UnsupportedPnpmWorkflowError extends ValidationSelectionError {}

// Read local PR workflows conservatively. No GitHub reads, shell evaluation,
// installs, or guessed script names belong in command selection.
export function pnpmValidation(root, pkg) {
  if (!existsSync(join(root, 'pnpm-lock.yaml'))) return null;
  try { return selectPnpmValidation(root, pkg); }
  catch (error) {
    if (error instanceof ValidationSelectionError) throw error;
    throw new ValidationSelectionError('pnpm-validation-selection-failed: workflow inputs are unreadable');
  }
}

function selectPnpmValidation(root, pkg) {
  const refuse = detail => { throw new UnsupportedPnpmWorkflowError(`pnpm-validation-unsupported: ${detail}`); };
  const pin = typeof pkg?.packageManager === 'string'
    && /^pnpm@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\+sha(?:224|256|384|512)\.[0-9a-fA-F]+)?$/.exec(pkg.packageManager);
  if (!pin) throw new ValidationSelectionError('pnpm-validation-selection-failed: packageManager must pin pnpm@x.y.z');
  const directory = join(root, '.github/workflows');
  const commands = [];
  for (const file of existsSync(directory) ? readdirSync(directory).sort() : []) {
    if (!/\.ya?ml$/.test(file)) continue;
    let workflow;
    try { workflow = load(readFileSync(join(directory, file), 'utf8')); }
    catch { refuse(`cannot parse ${file}`); }
    const triggers = workflow?.on;
    if (!(triggers === 'pull_request' || (Array.isArray(triggers) ? triggers.includes('pull_request')
      : triggers && Object.hasOwn(triggers, 'pull_request')))) continue;
    for (const job of Object.values(workflow.jobs || {})) {
      if (Object.hasOwn(job, 'if')) continue;
      for (const step of job.steps || []) {
        if (Object.hasOwn(step, 'if') || typeof step.run !== 'string') continue;
        for (const line of step.run.split('\n').map(value => value.trim())) {
          if (!/^pnpm(?:\s|$)/.test(line)) {
            if (/\bpnpm(?:\s|$)/.test(line) && !/^(?:#|corepack\s)/.test(line)) {
              refuse(`${file}: unsupported pnpm shell syntax: ${line}`);
            }
            continue;
          }
          const words = line.split(/\s+/);
          const scriptIndex = words[1] === 'run' ? 2 : 1;
          const script = words[scriptIndex];
          if (scriptIndex === 1 && ['install', 'i', '--version', '-v'].includes(script)) continue;
          if (!Object.hasOwn(pkg.scripts || {}, script)) refuse(`${file}: unsupported pnpm command: ${line}`);
          if (!words.every(word => /^[A-Za-z0-9_:.=/@+-]+$/.test(word))) refuse(`${file}: shell syntax in ${line}`);
          if (step['working-directory'] || job.defaults?.run?.['working-directory']
            || workflow.defaults?.run?.['working-directory'] || step.env || job.env || workflow.env
            || job.strategy?.matrix) refuse(`${file}: script requires workflow execution context`);
          const args = words.slice(scriptIndex);
          if (!commands.some(command => JSON.stringify(command) === JSON.stringify(args))) commands.push(args);
        }
      }
    }
  }
  if (!commands.length) refuse('no pnpm scripts selected from pull_request workflows');
  return {
    command: 'npm',
    args: ['exec', '--yes', `--package=pnpm@${pin[1]}`, '--', 'node',
      fileURLToPath(new URL('../../bin/validate-pnpm-scripts.mjs', import.meta.url)), JSON.stringify(commands)],
    required: true,
    startupReceipt: true,
    nominalSeconds: 1800,
  };
}
