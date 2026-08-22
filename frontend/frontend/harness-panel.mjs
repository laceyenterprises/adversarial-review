/**
 * Screen C, harness half: the panel that drives `POST /api/standup/harness/runs`
 * and renders its step stream (ARF-06).
 *
 * Plain ES modules, no framework, no build step — ARF has zero npm
 * dependencies and this is part of keeping it that way.
 *
 * The one interesting decision is how the stream is read. `EventSource` cannot
 * POST, so the run is started with `fetch` and the response body is read as a
 * stream and parsed as SSE here. The alternative — POST a run, then open an
 * `EventSource` against a run id — needs the server to keep a run addressable
 * after it finishes, which is state ARF would then have to expire.
 *
 * The step list renders failures as failures. A step that fails is red, its
 * message is shown verbatim, and the run status says `failed`: the whole point
 * of the allowlist step is that its failure is otherwise invisible, so this is
 * not a place to be gentle with the UI.
 */

const $ = (id) => document.getElementById(id);

const MARKS = { pending: '○', running: '▸', ok: '✔', skipped: '–', failed: '✖' };

let catalog = [];

function setStep(step, status, note) {
  const row = document.querySelector(`[data-step="${step}"]`);
  if (!row) return;
  row.dataset.status = status;
  row.querySelector('.mark').textContent = MARKS[status] ?? MARKS.pending;
  let detail = row.querySelector('.detail');
  if (!detail) {
    detail = document.createElement('span');
    detail.className = 'detail';
    row.appendChild(detail);
  }
  detail.textContent = note ? ` ${note}` : '';
}

function resetSteps() {
  for (const row of document.querySelectorAll('.steps li')) {
    setStep(row.dataset.step, 'pending', '');
  }
}

function splitList(value) {
  return String(value ?? '')
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** Build the harness spec the API validates. Empty optional fields are omitted
 *  rather than sent as empty strings, which the server would (rightly) refuse. */
function readForm() {
  const allowedModels = splitList($('allowedModels').value);
  const aliases = splitList($('aliases').value);
  const mode = $('modelAuthMode').value;

  const spec = {
    class: $('class').value.trim(),
    kind: $('kind').value,
    entitlement: $('entitlement').value.trim(),
    allowedModels,
    botIdentity: {
      login: $('botLogin').value.trim(),
      kind: $('identityKind').value,
    },
    modelAuth: mode === 'broker-oauth'
      ? { mode, brokerRole: $('brokerRole').value.trim() }
      : { mode, tokenRef: $('tokenRef').value.trim() },
    reviewerAllowlist: { enabled: $('allowlistEnabled').checked },
  };
  const defaultModel = $('defaultModel').value.trim();
  if (defaultModel) spec.defaultModel = defaultModel;
  if (aliases.length) spec.botIdentity.aliases = aliases;
  const command = $('runtimeCommand').value.trim();
  if (command) spec.runtime = { command };
  return spec;
}

function applyTemplate(id) {
  const template = catalog.find((entry) => entry.id === id);
  if (!template) return;
  const { spec } = template;
  $('class').value = spec.class ?? '';
  $('kind').value = spec.kind ?? 'reviewer';
  $('entitlement').value = spec.entitlement ?? '';
  $('allowedModels').value = (spec.allowedModels ?? []).join(', ');
  $('defaultModel').value = spec.defaultModel ?? '';
  $('botLogin').value = spec.botIdentity?.login ?? '';
  $('identityKind').value = spec.botIdentity?.kind ?? 'github_app';
  $('aliases').value = (spec.botIdentity?.aliases ?? []).join(', ');
  $('modelAuthMode').value = spec.modelAuth?.mode ?? 'broker-oauth';
  // Unconditional, like every other field here. Leaving the old value in place
  // when a template omits it means switching to a standalone-token template and
  // back to a broker one silently resurrects the previous template's role — from
  // a field that was hidden while the operator made the switch.
  $('brokerRole').value = spec.modelAuth?.brokerRole ?? '';
  $('tokenRef').value = spec.modelAuth?.tokenRef ?? '';
  $('runtimeCommand').value = spec.runtime?.command ?? '';
  syncModelAuthMode();
}

function syncModelAuthMode() {
  const broker = $('modelAuthMode').value === 'broker-oauth';
  $('broker-role-row').classList.toggle('hidden', !broker);
  $('token-ref-row').classList.toggle('hidden', broker);
}

function renderState(state) {
  $('context').textContent = `mode: ${state.mode} · manifest: ${state.paths.manifest} · `
    + `allowlist: ${state.paths.allowlist} · broker: ${state.broker?.mode ?? 'unavailable'}`;

  const roles = state.broker?.roles ?? [];
  $('brokerRole').replaceChildren(...roles.map((role) => {
    const option = document.createElement('option');
    option.value = role.role;
    option.textContent = `${role.role} (${role.provider})`;
    return option;
  }));
  if (roles.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    // Named rather than left blank: a broker with no mapped roles is exactly the
    // state that makes step 2 fail loud, and the operator should see it here.
    option.textContent = 'no roles mapped — broker-OAuth will fail loud';
    $('brokerRole').replaceChildren(option);
  }

  $('runtime-commands').replaceChildren(...(state.runtime?.commandAllowlist ?? []).map((command) => {
    const option = document.createElement('option');
    option.value = command;
    return option;
  }));

  const body = $('harnesses').querySelector('tbody');
  body.replaceChildren(...state.harnesses.map((harness) => {
    const tr = document.createElement('tr');
    const allowlist = harness.reviewerAllowlist ?? {};
    const cells = [
      harness.class,
      harness.entitlement,
      `${harness.modelAuth?.mode ?? '—'}${harness.modelAuth?.provisioned ? '' : ' (unprovisioned)'}`,
      harness.runtime ? `${harness.runtime.command}${harness.runtime.verified ? ' ✔' : ' ✖'}` : '—',
      allowlist.enabled === false
        ? 'off'
        : `${(allowlist.logins ?? []).join(', ') || '—'}${allowlist.verified ? ' ✔' : ' ✖'}`,
      harness.status,
    ];
    for (const value of cells) {
      const td = document.createElement('td');
      td.textContent = value;
      tr.appendChild(td);
    }
    tr.dataset.status = harness.status;
    return tr;
  }));

  $('allowlist').replaceChildren(...(state.allowlist?.entries ?? []).map((entry) => {
    const li = document.createElement('li');
    li.textContent = `${entry.logins.join(', ')} → ${entry.harnessClass} (${entry.entitlement})`;
    return li;
  }));
}

async function refreshState() {
  const res = await fetch('/api/standup/harness', { headers: { accept: 'application/json' } });
  if (res.ok) renderState(await res.json());
}

/** Parse an SSE byte stream into `{event, data}` records. */
async function* readSse(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let split = buffer.indexOf('\n\n');
    while (split !== -1) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      let event = 'message';
      const data = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7);
        else if (line.startsWith('data: ')) data.push(line.slice(6));
        // `: keep-alive` and anything else is a comment frame; ignored.
      }
      if (data.length) yield { event, data: JSON.parse(data.join('\n')) };
      split = buffer.indexOf('\n\n');
    }
  }
}

function describeStep(record) {
  const detail = record.detail ?? {};
  switch (record.step) {
    case 'register-class':
      return detail.dryRun ? 'validated (dry run)' : `${detail.class} · ${detail.entitlement}`;
    case 'provision-model-auth':
      return detail.dryRun
        ? `${detail.mode} (dry run)`
        : `${detail.mode} · ${detail.credential?.tokenType ?? 'resolved'} `
          + `${detail.credential?.fingerprint ?? ''}`.trim();
    case 'verify-runtime':
      if (detail.declared === false) return 'no runtime declared';
      return detail.dryRun
        ? `${detail.command}: ${detail.resolvedPath ?? 'not found'} (dry run)`
        : `${detail.version ?? detail.resolvedPath}`;
    case 'wire-allowlist':
      return detail.skipped ? 'not requested' : `${(detail.logins ?? []).join(', ')}`;
    case 'verify-allowlist':
      return detail.skipped ? 'not requested' : detail.detail ?? 'present';
    default:
      return '';
  }
}

async function runStandup(event) {
  event.preventDefault();
  const button = $('run');
  button.disabled = true;
  $('form-error').classList.add('hidden');
  resetSteps();
  $('run-status').textContent = 'starting…';

  try {
    const response = await fetch('/api/standup/harness/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ harness: readForm(), dryRun: $('dryRun').checked }),
    });

    if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) {
      const problem = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(problem.detail ?? 'the standup request was refused');
    }

    for await (const { event: name, data } of readSse(response)) {
      if (name === 'run.start') $('run-status').textContent = `run ${data.runId}${data.dryRun ? ' (dry run)' : ''}`;
      if (name === 'step.start') setStep(data.step, 'running', '');
      if (name === 'step.ok') setStep(data.step, 'ok', describeStep(data));
      if (name === 'step.skipped') setStep(data.step, 'skipped', data.reason ?? data.detail?.reason ?? '');
      if (name === 'step.failed') setStep(data.step, 'failed', `${data.code}: ${data.message}`);
      if (name === 'run.error') throw new Error(data.detail);
      if (name === 'run.done') {
        $('run-status').textContent = data.status === 'ready'
          ? `${data.class} is ready${data.dryRun ? ' (dry run — nothing was written)' : ''}`
          : `${data.class} is NOT ready — failed at ${data.failedStep}`;
        $('run-status').dataset.status = data.status;
      }
    }
  } catch (err) {
    $('form-error').textContent = err.message;
    $('form-error').classList.remove('hidden');
    $('run-status').textContent = 'failed';
    $('run-status').dataset.status = 'failed';
  } finally {
    button.disabled = false;
    await refreshState().catch(() => {});
  }
}

async function boot() {
  $('modelAuthMode').addEventListener('change', syncModelAuthMode);
  $('template').addEventListener('change', (event) => applyTemplate(event.target.value));
  $('harness-form').addEventListener('submit', runStandup);

  await refreshState();
  const res = await fetch('/api/standup/harness/catalog', { headers: { accept: 'application/json' } });
  catalog = res.ok ? (await res.json()).templates : [];
  $('template').replaceChildren(...[
    { id: '', label: 'blank' },
    ...catalog,
  ].map((template) => {
    const option = document.createElement('option');
    option.value = template.id;
    option.textContent = template.label;
    return option;
  }));
  syncModelAuthMode();
}

boot().catch((err) => {
  $('context').textContent = `panel failed to load: ${err.message}`;
});
