import test from 'node:test';
import assert from 'node:assert/strict';
import {createLegacyDevelopmentReconciler} from '../dist/modules/processes/infrastructure/reconcile-legacy-development.js';

const run={id:'run-1',project_id:'project-1',task_id:'task-1',status:'running',message:'Working'};

test('legacy run completion and task handoff commit atomically and only once',async()=>{
 const calls=[];
 let current='running',released=0;
 const pool={
  query:async(sql)=>{
   calls.push({sql,args:null});
   assert.match(sql,/cycle_id IS NULL/);
   return {rows:current==='running'?[run]:[]};
  },
  connect:async()=>({
   query:async(sql,args)=>{
    calls.push({sql,args});
    if(sql.includes('UPDATE ai_task_runs')){
     if(current!=='running')return {rowCount:0};
     current='completed';
     return {rowCount:1};
    }
    return {rowCount:1};
   },
   release:()=>released++
  })
 };
 const warnings=[];
 const reconcile=createLegacyDevelopmentReconciler(pool,async()=>({
  status:'completed',message:'PR created',branch:'task-1',prUrl:'https://github.com/acme/orders/pull/42',
  baseBranch:'main',usage:{input_tokens:30,cached_input_tokens:20,output_tokens:10}
 }),(...args)=>warnings.push(args));
 await reconcile();
 await reconcile();
 assert.equal(released,1);
 assert.deepEqual(warnings,[]);
 const writes=calls.filter(x=>x.args!==null);
 assert.equal(writes[0].sql,'BEGIN');
 assert.match(writes[1].sql,/UPDATE ai_task_runs SET status=\$2/);
 assert.match(writes[1].sql,/cycle_id IS NULL/);
 assert.match(writes[2].sql,/UPDATE tasks SET stage='testing'/);
 assert.match(writes[2].sql,/AND stage='development'/);
 assert.equal(writes[2].args[3],42);
 assert.ok(writes.some(x=>x.sql.includes('INSERT INTO ai_token_usage')));
 assert.ok(writes.some(x=>x.sql.includes('INSERT INTO process_events')));
 assert.equal(writes.at(-1).sql,'COMMIT');
});
test('simultaneous reconciliation calls share an in-flight execution',async()=>{
 let selects=0,remoteCalls=0;
 const pool={
  query:async()=>{selects++;return {rows:[run]}},
  connect:async()=>({query:async sql=>({rowCount:sql.includes('UPDATE ai_task_runs')?1:0}),release:()=>{}})
 };
 const reconcile=createLegacyDevelopmentReconciler(pool,async()=>{
  remoteCalls++;
  await new Promise(resolve=>setTimeout(resolve,20));
  return {status:'running',message:'Still running'};
 },()=>{});
 await Promise.all([reconcile(),reconcile(),reconcile()]);
 assert.equal(selects,1);
 assert.equal(remoteCalls,1);
});
test('connection failures do not prepend duplicate outage text on each tick',async()=>{
 let message='Working';
 const writes=[];
 const pool={
  query:async()=>({rows:[{...run,message}]}),
  connect:async()=>({
   query:async(sql,args)=>{
    writes.push({sql,args});
    if(sql.includes('UPDATE ai_task_runs')){message=args[2];return {rowCount:1}}
    return {rowCount:1}
   },
   release:()=>{}
  })
 };
 const reconcile=createLegacyDevelopmentReconciler(pool,async()=>{throw Error('503 offline')},()=>{});
 await reconcile();
 await reconcile();
 assert.equal(message,'Связь с исполнителем временно недоступна · Working');
 assert.equal(writes.filter(x=>x.sql.includes('UPDATE ai_task_runs')).length,1);
});
test('unexpected database errors roll back the run transition and are reported',async()=>{
 const statements=[],failures=[];
 const pool={
  query:async()=>({rows:[run]}),
  connect:async()=>({
   query:async sql=>{
    statements.push(sql);
    if(sql.includes('INSERT INTO process_events'))throw Error('database unavailable');
    return {rowCount:1};
   },
   release:()=>{}
  })
 };
 const reconcile=createLegacyDevelopmentReconciler(pool,async()=>({status:'failed',message:'Failed'}),
  (error,id)=>failures.push([error.message,id]));
 await reconcile();
 assert.ok(statements.includes('ROLLBACK'));
 assert.equal(statements.includes('COMMIT'),false);
 assert.deepEqual(failures,[['database unavailable','run-1']]);
});
