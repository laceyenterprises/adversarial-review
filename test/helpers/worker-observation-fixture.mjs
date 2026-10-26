// Synthetic policy fixtures at the public SDK transport seam. These databases
// build fixture replies only; production readers never open them.
import {mock} from 'node:test';
import Database from 'better-sqlite3';
import {dispatchReadTransport} from '../../src/dispatch-read-client.mjs';

function reply(selector, args) {
  if (args.dispatchSession) return args.dispatchSession.dispatchLookup(selector);
  if (args.workerObservationSyncImpl) return args.workerObservationSyncImpl(selector);
  let source = args.ledgerTarget?.path ?? args.ledgerTarget ?? args.ledgerDbPath ?? args.env?.AGENT_OS_SESSION_LEDGER_TARGET;
  if (typeof source === 'string' && source.startsWith('sqlite://')) source = source.slice('sqlite://'.length);
  if (!source || typeof source !== 'string') throw new Error('synthetic observation unavailable');
  const db = new Database(source,{readonly:true,fileMustExist:true});
  let items;
  try {
    if (selector.observation === 'workers') {
      const runs = db.prepare('SELECT * FROM worker_runs').all();
      items = selector.worker_run_id ? runs.filter(r=>r.run_id===selector.worker_run_id) : [];
      if (!items.length && selector.launch_request_id) items = runs.filter(r=>r.launch_request_id===selector.launch_request_id);
      for (const row of items) {
        row.token_usage_guardrail ??= null;
        const session = db.prepare("SELECT name FROM sqlite_master WHERE name='runtime_sessions'").get()
          ? db.prepare('SELECT * FROM runtime_sessions WHERE session_id=?').get(row.session_id ?? '') : null;
        row.total_cache_read_tokens = session?.total_cache_read_tokens ?? null;
        row.total_cache_write_tokens = session?.total_cache_write_tokens ?? null;
        if (db.prepare("SELECT name FROM sqlite_master WHERE name='worker_processes'").get()) {
          const processes = db.prepare('SELECT * FROM worker_processes WHERE launch_request_id=?').all(row.launch_request_id)
            .sort((a,b)=>String(b.updated_at||b.exited_at||b.started_at||b.created_at||'').localeCompare(String(a.updated_at||a.exited_at||a.started_at||a.created_at||'')) || Number(b.worker_process_id) - Number(a.worker_process_id));
          row.pid = processes[0]?.pid ?? null;
          row.process_status = processes[0]?.process_status ?? null;
        }
      }
      items.sort((a,b)=>String(b.updated_at||b.ended_at||b.started_at||'').localeCompare(String(a.updated_at||a.ended_at||a.started_at||'')) || b.run_id.localeCompare(a.run_id));
    } else if (selector.observation === 'sessions') {
      items = db.prepare('SELECT * FROM runtime_sessions').all()
        .filter(row=>selector.session_keys.includes(row.adapter_session_key)||selector.session_keys.includes(row.session_id))
        .map(({source_path:_path,...row})=>({...row,updated_at:row.ended_at}));
      items.sort((a,b)=>String(b.ended_at||b.started_at||'').localeCompare(String(a.ended_at||a.started_at||'')) || b.session_id.localeCompare(a.session_id));
    } else throw new Error('synthetic observation selector unavailable');
  } finally {db.close();}
  const page = items.slice(selector.offset??0,(selector.offset??0)+(selector.limit??50));
  return {schema_version:1,observation:selector.observation,status:items.length?'found':'not_found',
    items:page,complete:true,next_offset:null,scope_complete:false,mutation_authority:false};
}
const lookup = dispatchReadTransport.lookup;
mock.method(dispatchReadTransport,'lookup',async(selector,args)=>selector.observation ? reply(selector,args) : lookup(selector,args));
mock.method(dispatchReadTransport,'observationSync',reply);

export {reply as workerObservationFixture};
