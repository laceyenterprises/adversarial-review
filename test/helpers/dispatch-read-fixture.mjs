// Synthetic consumer policy fixtures at the SDK transport boundary. These
// disposable test databases are fixture builders, never application fallbacks.
import { mock } from 'node:test';
import Database from 'better-sqlite3';
import { dispatchReadTransport } from '../../src/dispatch-read-client.mjs';

function fixture(selector, args) {
  if(args.dispatchSession) return args.dispatchSession.dispatchLookup(selector);
  if(args.dispatchLookupSyncImpl) return args.dispatchLookupSyncImpl(selector);
  const path=args.ledgerTarget?.path ?? args.ledgerDbPath;
  if(!path) throw new Error('fixture unavailable');
  const db=new Database(path,{readonly:true,fileMustExist:true});
  let rows;
  try { rows=db.prepare('SELECT * FROM launch_requests').all(); }
  finally { db.close(); }
  const roots=rows.filter(row=>selector.launch_request_ids?.includes(row.launch_request_id)
    || selector.idempotency_key && row.idempotency_key===selector.idempotency_key
    || selector.ticket_ref && row.ticket_ref===selector.ticket_ref
      && (!Number.isFinite(Date.parse(row.requested_at)) || Date.parse(row.requested_at)>=Date.parse(selector.requested_at_or_after)));
  const ids=new Set(roots.map(row=>row.launch_request_id));
  const edges=[];
  for(const row of rows) {
    let metadata; try {metadata=JSON.parse(row.metadata_json);} catch {continue;}
    if(typeof metadata?.retryOf==='string') edges.push({parent:metadata.retryOf,child:row.launch_request_id});
  }
  if(selector.include_retry_chain) for(const id of ids) for(const edge of edges) if(edge.parent===id) ids.add(edge.child);
  const items=rows.filter(row=>ids.has(row.launch_request_id)).map(({metadata_json:_metadata,...row})=>({ticket_ref:null,target_repo:null,head_sha:null,failure_detail:null,...row}))
    .sort((a,b)=>String(b.updated_at??'').localeCompare(String(a.updated_at??'')) || b.launch_request_id.localeCompare(a.launch_request_id));
  return {schema_version:1,status:roots.length?'found':'not_found',complete:true,
    roots:roots.map(row=>row.launch_request_id),items,
    retry_edges:edges.filter(edge=>ids.has(edge.parent)&&ids.has(edge.child))};
}
mock.method(dispatchReadTransport,'lookup',async(selector,args)=>fixture(selector,args));
mock.method(dispatchReadTransport,'lookupSync',(selector,args)=>fixture(selector,args));
