import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
// Offline PR 8132 shape: 10 primary files, 13 final files, ~185 KB JSON.
// Model 20 ms API/process latency; this does not measure the production host.
// Run: node test/helpers/primary-change-timing.mjs [baseline-ref]
const root = process.cwd();
const baselineDir = mkdtempSync(join(tmpdir(), 'pcc-baseline-'));
for (const name of ['history-reader', 'primary-change']) {
  const source = execFileSync('git', ['show', `${process.argv[2] || 'origin/main'}:src/ama/${name}.mjs`], { encoding: 'utf8' });
  writeFileSync(join(baselineDir, `${name}.mjs`), source.replace(/from '(\.[^']+)'/g,
    (_, relative) => `from '${pathToFileURL(join(root, 'src/ama', relative))}'`));
}
const { createHistoryReader: beforeReader } = await import(pathToFileURL(join(baselineDir, 'history-reader.mjs')));
const { fetchPrimaryChange: beforeFetch } = await import(pathToFileURL(join(baselineDir, 'primary-change.mjs')));
const { createHistoryReader: afterReader } = await import(pathToFileURL(join(root,'src/ama/history-reader.mjs')));
const { fetchPrimaryChange: afterFetch } = await import(pathToFileURL(join(root,'src/ama/primary-change.mjs')));
const base='a'.repeat(40), primary='b'.repeat(40), head='c'.repeat(40);
const dir=mkdtempSync(join(tmpdir(),'pcc-bench-'));
const sha=(i,version)=>String(i+version*1000).padStart(40,'0');
const tree=(version,count)=>Array.from({length:count},(_,i)=>({path:`file-${i}.mjs`,type:'blob',mode:'100644',sha:sha(i,version)}));
const contents=version=>`${version === 0 ? 'before' : 'after!'} ${'x'.repeat(13)}\n`.repeat(171);
let calls=0;
const exec=async ({args})=>{
 calls++;
 await new Promise(resolve=>setTimeout(resolve,20));
 const path=args[1];
 let value;
 if(path.includes('/reviews?')) value=[];
 else if(path.includes('/pulls/')) value={head:{sha:head},base:{sha:base}};
 else if(path.includes('/compare/')) value={status:'ahead',merge_base_commit:{sha:base},total_commits:path.includes(head)?2:1,commits:[{sha:primary,commit:{message:'builder'}},...(path.includes(head)?[{sha:head,parents:[{sha:primary}],commit:{message:'repair\n\nWorker-Class: hammer'}}]:[])]};
 else if(path.includes('/git/trees/')) value={tree:path.endsWith(base)?tree(0,13):path.endsWith(primary)?[...tree(1,10),...tree(0,13).slice(10)]:tree(1,13),truncated:false};
 else if(path.includes('/git/blobs/')) {const text=contents(Number(path.split('/').at(-1))>=1000?1:0);value={encoding:'base64',content:Buffer.from(text).toString('base64'),size:Buffer.byteLength(text)};}
 else throw Error(path);
 return {stdout:JSON.stringify(value)};
};
try {
 for(const [label,reader,fetch] of [['before',beforeReader,beforeFetch],['after cold',afterReader,afterFetch],['after warm',afterReader,afterFetch]]) {
  calls=0;
  const start=performance.now();
  const result=await fetch({repo:'fixture/repo',prNumber:8132,headSha:head,rootDir:dir,get:reader({execGhWithRetryImpl:exec})},{fetchCiCostImpl:async()=>({headSha:head,ok:true})});
  console.log(JSON.stringify({label,ms:Math.round(performance.now()-start),apiCalls:calls,primaryFiles:result.primaryFiles?.length,finalFiles:result.finalFiles?.length,bytes:Buffer.byteLength(JSON.stringify(result))}));
 }
} finally {rmSync(dir,{recursive:true,force:true});rmSync(baselineDir,{recursive:true,force:true});}
