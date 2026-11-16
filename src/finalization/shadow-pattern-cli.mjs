import { openFinalizationShadowStore, openReadOnlyFinalizationShadowStore } from './shadow-store.mjs';

export const PATTERN_USAGE = `  adversarial-review finalization shadow-pattern list [--root DIR]
  adversarial-review finalization shadow-pattern add --key KEY --kind equivalent|v2-defect|policy --principal PRINCIPAL --note NOTE --evidence IDS [--ticket REF] [--expires-at ISO] [--root DIR]
  adversarial-review finalization shadow-pattern revoke --id ID --principal PRINCIPAL --note NOTE [--root DIR]
  adversarial-review finalization shadow-pattern apply-existing --id ID [--dry-run | --apply --principal PRINCIPAL] [--root DIR]
`;

export function shadowPatternMain(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout, stderr = io.stderr ?? process.stderr;
  const [command, ...args] = argv;
  const options = { rootDir: process.cwd() };
  const flags = { '--root': 'rootDir', '--key': 'key', '--kind': 'kind', '--principal': 'principal',
    '--note': 'note', '--evidence': 'evidence', '--ticket': 'ticketRef', '--expires-at': 'expiresAt', '--id': 'id' };
  const allowed = { list: ['rootDir'], add: ['rootDir', 'key', 'kind', 'principal', 'note', 'evidence', 'ticketRef', 'expiresAt'],
    revoke: ['rootDir', 'id', 'principal', 'note'], 'apply-existing': ['rootDir', 'id', 'principal', 'apply', 'dry-run'] };
  try {
    if (!allowed[command]) throw new Error('expected add, list, revoke or apply-existing');
    const seen = new Set();
    for (let i = 0; i < args.length; i++) {
      const boolean = ['--apply', '--dry-run'].includes(args[i]);
      const name = boolean ? args[i].slice(2) : flags[args[i]];
      if (boolean && command === 'apply-existing' && !seen.has(name)) {
        seen.add(name); options[name] = true; continue;
      }
      if (!name || !allowed[command].includes(name) || seen.has(name) || !args[i + 1]
        || args[i + 1].startsWith('--')) throw new Error('invalid pattern arguments');
      seen.add(name);
      options[name] = args[++i];
    }
    if (command === 'add') {
      if (!options.key || !options.kind || !options.principal || !options.note
        || !/^[1-9]\d*(,[1-9]\d*)*$/.test(options.evidence ?? '')) throw new Error('missing or invalid pattern fields');
      options.evidenceSampleIds = options.evidence.split(',').map(Number);
    }
    if (command === 'revoke' && (!/^[1-9]\d*$/.test(options.id ?? '') || !options.principal || !options.note)) {
      throw new Error('id, principal and note required');
    }
    if (command === 'apply-existing' && (!/^[1-9]\d*$/.test(options.id ?? '')
      || !Number.isSafeInteger(Number(options.id)) || (options.apply && options['dry-run'])
      || (options.apply && !options.principal?.trim()) || (!options.apply && options.principal))) {
      throw new Error('id required; --apply requires principal and excludes --dry-run');
    }
  } catch (err) { stderr.write(`error: ${err.message}\n${PATTERN_USAGE}`); return 2; }
  if (command === 'apply-existing') return applyExistingMain(options, io, stdout, stderr);
  let store;
  try {
    const open = command === 'list' ? io.openPatternReadStore ?? openReadOnlyFinalizationShadowStore
      : io.openPatternStore ?? openFinalizationShadowStore;
    store = open({ rootDir: options.rootDir });
    const at = io.now ?? new Date().toISOString();
    const result = command === 'list' ? store.listPatterns()
      : command === 'add' ? store.addPattern({ ...options, at })
        : store.revokePattern(Number(options.id), { principal: options.principal, note: options.note, at });
    stdout.write(JSON.stringify(result, null, 2) + '\n');
    return 0;
  } catch (err) { stderr.write(`error: shadow pattern ${command} failed: ${err.message}\n`); return 1; }
  finally { store?.close(); }
}

async function applyExistingMain(options, io, stdout, stderr) {
  let store;
  try {
    const open = options.apply ? io.openPatternStore ?? openFinalizationShadowStore
      : io.openPatternReadStore ?? openReadOnlyFinalizationShadowStore;
    store = open({ rootDir: options.rootDir });
    const audit = { at: io.now ?? new Date().toISOString(), principal: options.principal, apply: options.apply };
    const result = options.apply ? await store.applyPatternToExisting(Number(options.id), audit)
      : store.planPatternApplication(Number(options.id), audit);
    stdout.write(JSON.stringify(result, null, 2) + '\n');
    return 0;
  } catch (err) { stderr.write(`error: shadow pattern apply-existing failed: ${err.message}\n`); return 1; }
  finally { store?.close(); }
}
