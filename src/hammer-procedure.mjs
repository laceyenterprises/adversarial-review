// Shared dispatch/CLI renderer. Procedure sources belong to this deployed checkout.
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const HAMMER_PHASES = ['hammer-verify-head', 'hammer-publish', 'hammer-merge'];

// Keep rare procedures byte-for-byte in a private reference file. The main
// prompt retains the rule and the condition for consulting each appendix.
export function splitHammerPrompt(template) {
  const appendices = [];
  const prompt = template.replace(
    /<!-- hammer-reference:([A-Z][0-9]+) -->\n([\s\S]*?)\n<!-- \/hammer-reference:\1 -->/g,
    (_match, name, content) => {
      appendices.push(`## Appendix ${name}\n\n${content}`);
      return `Read **Appendix ${name}** in \`<<RUN_DIR>>/hammer-reference.md\` when the condition above applies.`;
    },
  );
  if (/<!-- \/?hammer-reference:/.test(prompt)) {
    throw new Error('malformed hammer reference appendix');
  }
  return { prompt, reference: appendices.length
    ? `# Hammer reference appendices\n\nConsult only the appendix named by the operating prompt or phase outcome.\n\n${appendices.join('\n\n')}\n`
    : '' };
}

export function renderHammerProcedure(phase, values) {
  if (!HAMMER_PHASES.includes(phase)) throw new Error(`unknown hammer phase: ${phase}`);
  const path = fileURLToPath(new URL(`../bin/${phase}.sh`, import.meta.url));
  let source = readFileSync(path, 'utf8');
  const sourceHash = createHash('sha256').update(source).digest('hex');
  // Run unconditionally: placing a shell function in `if` disables errexit in
  // every nested function. Record handled refusals after return, and fatal
  // errexit failures through ERR without replacing the lease's EXIT trap.
  source = source.replace(/^(#![^\n]*\n)?/, `$1export HAM_REPO='<<REPO>>' HAM_PR_NUMBER='<<PR_NUMBER>>'
export HAM_HQ_ROOT='<<HQ_ROOT>>' HAM_TARGET_REMEDIATION_SHA='<<TARGET_REMEDIATION_SHA>>'
ham_record_phase_failure() {
  "\${HAM_NODE_BIN:-node}" <<ROOT_DIR>>/bin/hammer-terminal-audit.mjs "\${HAM_PHASE_OUTCOME:-${phase}-failed}" "\${POST_REMEDIATION_SHA:-<<TARGET_REMEDIATION_SHA>>}" || echo 'HAM terminal failure audit unavailable' >&2
}
ham_run_rendered_phase() {
`) + `
}
ham_phase_previous_err_trap=$(trap -p ERR)
ham_phase_previous_errtrace=0
[[ $- == *E* ]] && ham_phase_previous_errtrace=1
set -E
trap 'ham_phase_error=$?; if [[ $- == *e* ]]; then ham_record_phase_failure; fi' ERR
ham_run_rendered_phase "$@"
ham_phase_exit=$?
trap - ERR
eval "$ham_phase_previous_err_trap"
if [ "$ham_phase_previous_errtrace" -eq 0 ]; then set +E; fi
if [ "$ham_phase_exit" -ne 0 ]; then ham_record_phase_failure; fi
# HAMPROMPT-01: outcomes name prompt appendices, never script source to inspect.
case "${phase}:$ham_phase_exit" in
  hammer-verify-head:0)
    echo 'HAM next: Appendix C revalidation if HAM_NEEDS_REVALIDATION=true; otherwise Appendix E audit/predicate/merge.' >&2 ;;
  hammer-verify-head:21|hammer-merge:21)
    echo 'HAM next: Appendix D — Resolving merge conflicts. Query/release lease, repair, publish commit, revalidate; re-enter verify-head.' >&2 ;;
  hammer-publish:0)
    if [ "\${HAM_COMMIT_PUBLICATION_ONLY:-0}" = "1" ]; then
      echo 'HAM next: unset HAM_COMMIT_PUBLICATION_ONLY; refresh context; run verify-head (Appendix C).' >&2
    else
      echo 'HAM next: Appendix E exact-head predicate, then merge.' >&2
    fi ;;
  hammer-merge:0)
    echo 'HAM next: Appendix E confirmed-merge closing audit.' >&2 ;;
  *)
    echo "HAM next: stop with \${HAM_PHASE_OUTCOME:-${phase}-failed}; preserve deferrals and authoritative terminal state (Appendix B mandate 0b / Appendix E). Do not read phase source." >&2 ;;
esac
return "$ham_phase_exit"
`;
  // These defaults belong to the versioned procedure, never the renderer's
  // caller environment. Embed each floor at the assignment's original site.
  source = source.replace(
    /^(HAM_[A-Z_]*(?:WAIT_SECONDS|POLL_SECONDS|RETRY_CAP|ATTEMPT_CAP|FAILURE_LIMIT|BACKOFF_BASE_SECONDS|NOMINAL_SECONDS))="\$\{\1:-([0-9]+)\}"$/gm,
    (_match, name, floor) => `ham_procedure_floor ${name} ${floor}`,
  );
  const procedureFloor = `# hammer-procedure-source-sha256: ${sourceHash}
# Waits are fixed by the procedure; do not export or shorten them.
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
