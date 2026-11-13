import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {z} from 'zod';
import {registerMergeOperationsRoutes} from '../dist/modules/execution/api/merge-operations.js';

const project='123e4567-e89b-42d3-a456-426614174002';
const task='123e4567-e89b-42d3-a456-426614174004';
const batch='123e4567-e89b-42d3-a456-426614174005';
const actor='123e4567-e89b-42d3-a456-426614174001';
const batchRow={id:batch,projectId:project,status:'queued',message:'Ожидает запуска Temporal'};

function fixture({allowed=true,admin=true,activeBatch=false}={}){
 const calls=[],starts=[],records=[];
 const query=async(sql,args)=>{
  calls.push({sql,args});
  if(sql==='BEGIN'||sql==='COMMIT'||sql==='ROLLBACK')return {rows:[],rowCount:0};
  if(sql.startsWith('SELECT id FROM projects'))return {rows:[{id:project}],rowCount:1};
  if(sql.startsWith('SELECT id FROM merge_process_runs WHERE project_id'))return {rows:activeBatch?[{id:batch}]:[],rowCount:activeBatch?1:0};
  if(sql.startsWith('SELECT id,depends_on_task_id FROM tasks'))return {rows:[],rowCount:0};
  if(sql.startsWith('INSERT INTO merge_process_runs')){records.push(args);return {rows:[],rowCount:1};}
  if(sql.startsWith('SELECT id,project_id AS'))return {rows:activeBatch?[batchRow]:records.length?[{...batchRow,id:records[0][0],status:'completed'}]:[],rowCount:1};
  if(sql.startsWith('SELECT t.id,t.title,t.stage'))return {rows:[],rowCount:0};
  throw Error('Unexpected SQL: '+sql);
 };
 let released=0;
 const pool={query,connect:async()=>({query,release:()=>released++})};
 const client={withDeadline:async(_at,fn)=>fn(),workflow:{start:async(name,options)=>{
  starts.push({name,options});
 }}};
 const app=Fastify();
 app.setErrorHandler((error,_request,reply)=>{
  if(error instanceof z.ZodError)return reply.code(400).send({error:'Некорректные данные'});
  return reply.code(500).send({error:'Internal error'});
 });
 const actions=registerMergeOperationsRoutes({app,pool,uid:()=>actor,
  access:async(_req,reply)=>{
   if(!allowed){reply.code(403).send({error:'Нет доступа к проекту'});return false;}
   return true;
  },
  requireAdmin:async(_req,reply)=>{
   if(!admin){reply.code(403).send({error:'Только администратор'});return false;}
   return true;
  },
  temporal:async()=>client,
  decryptToken:()=>{throw Error('not called without GitHub connection');}
 });
 return {app,calls,starts,actions,records,released:()=>released};
}

test('merge endpoint preserves authorization, admin gate and missing PR response',async()=>{
 for(const options of [{allowed:false},{admin:false},{}]){
  const f=fixture(options);
  try{
   const res=await f.app.inject({method:'POST',url:'/api/projects/'+project+'/tasks/'+task+'/merge'});
   const denied=options.allowed===false||options.admin===false;
   assert.equal(res.statusCode,denied?403:404);
   assert.equal(f.calls.length,denied?0:1);
   assert.equal(f.starts.length,0);
  }finally{await f.app.close();}
 }
});

test('merge batch creation keeps transaction and does not start a duplicate workflow from HTTP',async()=>{
 const f=fixture();
 try{
  const res=await f.app.inject({method:'POST',url:'/api/projects/'+project+'/merge-ready'});
  assert.equal(res.statusCode,202,JSON.stringify(res.json()));
  assert.equal(res.json().status,'completed');
  assert.equal(f.records.length,1);
  assert.deepEqual(f.records[0].slice(1,3),[project,actor]);
  assert.equal(f.records[0][3],'completed');
  assert.equal(f.calls[0].sql,'BEGIN');
  assert.equal(f.calls.at(-1).sql,'COMMIT');
  assert.equal(f.released(),1);
  assert.equal(f.starts.length,0,'Temporal starts only through the existing reconciliation path');
 }finally{await f.app.close();}
});

test('existing active merge batch is idempotently reused',async()=>{
 const f=fixture({activeBatch:true});
 try{
  const res=await f.app.inject({method:'POST',url:'/api/projects/'+project+'/merge-ready'});
  assert.equal(res.statusCode,202);
  assert.equal(res.json().id,batch);
  assert.equal(f.records.length,0);
  assert.equal(f.calls.at(-1).sql,'COMMIT');
 }finally{await f.app.close();}
});

test('merge batch history is project scoped and responds 404 when absent',async()=>{
 const f=fixture();
 try{
  const res=await f.app.inject({url:'/api/projects/'+project+'/merge-ready/'+batch});
  assert.equal(res.statusCode,404);
  const found=f.calls[0];
  assert.deepEqual(found.args,[batch,project]);
 }finally{await f.app.close();}
});

test('merge batch history is denied before SQL when project membership is missing',async()=>{
 const f=fixture({allowed:false});
 try{
  const res=await f.app.inject({url:'/api/projects/'+project+'/merge-ready/'+batch});
  assert.equal(res.statusCode,403);
  assert.equal(f.calls.length,0);
 }finally{await f.app.close();}
});

test('recovery starts exact Temporal workflow ID with bounded deadline and fixed queue',async()=>{
 const f=fixture();
 try{
  await f.actions.startMergeBatch(batch);
  assert.equal(f.starts.length,1);
  assert.equal(f.starts[0].name,'mergeReadyBatch');
  assert.deepEqual(f.starts[0].options,{workflowId:'merge-ready-'+batch,
   workflowIdReusePolicy:'REJECT_DUPLICATE',taskQueue:'agent-pipeline',args:[batch]});
 }finally{await f.app.close();}
});
