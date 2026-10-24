// Shared dispatch/CLI renderer. Procedure sources belong to this deployed checkout.
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

export const HAMMER_PHASES = ['hammer-verify-head', 'hammer-publish', 'hammer-merge'];

export function renderHammerProcedure(phase, values) {
  if (!HAMMER_PHASES.includes(phase)) throw new Error(`unknown hammer phase: ${phase}`);
  const path = fileURLToPath(new URL(`../bin/${phase}.sh`, import.meta.url));
  let source = readFileSync(path, 'utf8');
  // Install failure recording before lease checks, temporary files or GitHub calls.
  // All phases are sourced; a phase-local return must settle its audit first.
  source = source.replace(/^(#![^\n]*\n)?/, `$1export HAM_REPO='<<REPO>>' HAM_PR_NUMBER='<<PR_NUMBER>>'
export HAM_HQ_ROOT='<<HQ_ROOT>>' HAM_TARGET_REMEDIATION_SHA='<<TARGET_REMEDIATION_SHA>>'
ham_run_rendered_phase() {
`) + `
}
if ham_run_rendered_phase "$@"; then
  return 0
else
  ham_phase_exit=$?
  "\${HAM_NODE_BIN:-node}" <<ROOT_DIR>>/bin/hammer-terminal-audit.mjs "\${HAM_PHASE_OUTCOME:-${phase}-failed}" "\${POST_REMEDIATION_SHA:-<<TARGET_REMEDIATION_SHA>>}" || echo 'HAM terminal failure audit unavailable' >&2
  return "$ham_phase_exit"
fi
`;
  // These defaults belong to the versioned procedure, never the renderer's
  // caller environment. Embed each floor at the assignment's original site.
  source = source.replace(
    /^(HAM_[A-Z_]*(?:WAIT_SECONDS|POLL_SECONDS|RETRY_CAP|ATTEMPT_CAP|FAILURE_LIMIT|BACKOFF_BASE_SECONDS|NOMINAL_SECONDS))="\$\{\1:-([0-9]+)\}"$/gm,
    (_match, name, floor) => `ham_procedure_floor ${name} ${floor}`,
  );
  const procedureFloor = `# Waits are fixed by the procedure; do not export or shorten them.
# A hammer that has only the lease left waits for it.
ham_procedure_floor() {
  local name="$1" floor="$2" given normalized used
  given="\${!name-}"
  used="$floor"
  normalized="$given"
  while [[ "$normalized" == 0* ]] && [ "\${#normalized}" -gt 1 ]; do
    normalized="\${normalized:1}"
  done
  if [[ "$normalized" =~ ^[0-9]+$ ]] && {
    [ "\${#normalized}" -gt "\${#floor}" ] ||
    { [ "\${#normalized}" -eq "\${#floor}" ] && [[ "$normalized" > "$floor" || "$normalized" == "$floor" ]]; }
  }; then
    used="$normalized"
  elif [ -n "$given" ]; then
    echo "HAM procedure floor: $name given=$given used=$used" >&2
  fi
  printf -v "$name" '%s' "$used"
}
`;
  // Keep the interpreter header at byte zero for executable rendered scripts.
  const shebang = source.match(/^#![^\n]*\n/)?.[0];
  source = shebang
    ? `${shebang}${procedureFloor}${source.slice(shebang.length)}`
    : `${procedureFloor}${source}`;
  values = { ...values, TARGET_REMEDIATION_SHA: values.TARGET_REMEDIATION_SHA || values.REVIEWED_SHA };
  const missing = new Set();
  source = source.replace(/<<([A-Z_]+)>>/g, (_match, key) => {
    const value = values[key];
    if (value === undefined || value === '') {
      missing.add(key);
      return '';
    }
    return value;
  });
  if (missing.size) {
    throw Object.assign(new Error(`missing dispatch values: ${[...missing].join(', ')}`), { exitCode: 64 });
  }
  return source;
}
