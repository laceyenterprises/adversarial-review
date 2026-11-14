import { openFinalizationShadowStore, openReadOnlyFinalizationShadowStore } from './shadow-store.mjs';

export const PATTERN_USAGE = `  adversarial-review finalization shadow-pattern list [--root DIR]
  adversarial-review finalization shadow-pattern add --key KEY --kind equivalent|v2-defect|policy --principal PRINCIPAL --note NOTE --evidence IDS [--ticket REF] [--expires-at ISO] [--root DIR]
  adversarial-review finalization shadow-pattern revoke --id ID --principal PRINCIPAL --note NOTE [--root DIR]
`;

export function shadowPatternMain(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout, stderr = io.stderr ?? process.stderr;
  const [command, ...args] = argv;
  const options = { rootDir: process.cwd() };
  const flags = { '--root': 'rootDir', '--key': 'key', '--kind': 'kind', '--principal': 'principal',
    '--note': 'note', '--evidence': 'evidence', '--ticket': 'ticketRef', '--expires-at': 'expiresAt', '--id': 'id' };
  const allowed = { list: ['rootDir'], add: ['rootDir', 'key', 'kind', 'principal', 'note', 'evidence', 'ticketRef', 'expiresAt'],
    revoke: ['rootDir', 'id', 'principal', 'note'] };
  try {
    if (!allowed[command]) throw new Error('expected add, list or revoke');
    const seen = new Set();
    for (let i = 0; i < args.length; i++) {
      const name = flags[args[i]];
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
  } catch (err) { stderr.write(`error: ${err.message}\n${PATTERN_USAGE}`); return 2; }
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
