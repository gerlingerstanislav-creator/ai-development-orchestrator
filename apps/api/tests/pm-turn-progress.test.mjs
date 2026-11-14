import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import Fastify from 'fastify';
import {initPmTurnProgress,appendPmTurnProgress,readPmTurnProgress,registerPmProgressRoutes}
 from '../dist/modules/planning/infrastructure/pm-turn-progress.js';

test('PM progress is durable, idempotent, attempt-scoped and inaccessible across projects',async t=>{
 const db=new pg.Client({connectionString:process.env.DATABASE_URL});
 await db.connect();
 const schema='pmprogress_'+randomUUID().replaceAll('-','');
 const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema+',public'});
 const app=Fastify();
 t.after(async()=>{await app.close();await pool.end();await db.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await db.end();});
 await db.query('CREATE SCHEMA '+schema);
 await db.query('SET search_path TO '+schema+',public');
 await db.query(`CREATE TABLE assistant_messages(
  id uuid PRIMARY KEY,project_id uuid NOT NULL,role text NOT NULL,
  channel text NOT NULL,status text NOT NULL,pm_dispatch_attempt int NOT NULL DEFAULT 1
 );`);
 const project=randomUUID(),other=randomUUID(),message=randomUUID();
 await db.query("INSERT INTO assistant_messages(id,project_id,role,channel,status) VALUES($1,$2,'user','project','processing')",[message,project]);
 await initPmTurnProgress(pool);
 await initPmTurnProgress(pool);
 const secret='a'.repeat(40);
 registerPmProgressRoutes(app,{pool,runnerSecret:secret,
  access:async(_req,reply,id)=>{if(id===project)return true;reply.code(403).send({error:'forbidden'});return false;},
  requireAdmin:async()=>true
 });
 const endpoint='/internal/pm-turn-progress',url='/api/projects/'+project+'/manager/inbox/progress';
 const event={projectId:project,messageId:message,attempt:1,sequence:1,kind:'summary',text:'Сверяю условия задачи'};
 assert.equal((await app.inject({method:'POST',url:endpoint,payload:event})).statusCode,403);
 assert.equal((await app.inject({method:'POST',url:endpoint,headers:{'x-runner-secret':secret},payload:{...event,text:'Bearer github-test-secret-should-not-log',kind:'raw'}})).statusCode,400);
 const headers={'x-runner-secret':secret};
 assert.equal((await app.inject({method:'POST',url:endpoint,headers,payload:event})).statusCode,201);
 assert.equal((await app.inject({method:'POST',url:endpoint,headers,payload:event})).statusCode,202);
 const events=await readPmTurnProgress(pool,project,0);
 assert.equal(events.length,1);
 assert.deepEqual(events[0].message_id,message);
 const snapshot=await app.inject({method:'GET',url});
 assert.equal(snapshot.statusCode,200);
 assert.equal(snapshot.json().events.length,1);
 assert.equal((await app.inject({method:'GET',url:'/api/projects/'+other+'/manager/inbox/progress'})).statusCode,403);
 const origin=await app.listen({host:'127.0.0.1',port:0});
 const controller=new AbortController();
 try{
  const stream=await fetch(origin+url,{headers:{Accept:'text/event-stream'},signal:controller.signal});
  assert.equal(stream.status,200);
  assert.match(stream.headers.get('content-type'),/text\/event-stream/);
  const reader=stream.body.getReader(),decoder=new TextDecoder();
  let collected='';
  while(!collected.includes('event: progress')&&collected.length<5000){
   const chunk=await reader.read();
   if(chunk.done)break;
   collected+=decoder.decode(chunk.value);
  }
  assert.match(collected,/event: progress/);
 }finally{controller.abort();}

 await db.query("UPDATE assistant_messages SET status='completed' WHERE id=$1",[message]);
 assert.equal((await app.inject({method:'POST',url:endpoint,headers,payload:{...event,sequence:2}})).statusCode,202);
 assert.equal((await readPmTurnProgress(pool,project,0)).length,1);
 await db.query("UPDATE assistant_messages SET status='processing',pm_dispatch_attempt=2 WHERE id=$1",[message]);
 assert.equal((await appendPmTurnProgress(pool,{...event,sequence:3})).accepted,false,'stale progress is rejected');
 assert.equal((await appendPmTurnProgress(pool,{...event,attempt:2,sequence:1})).accepted,true);
 assert.equal((await readPmTurnProgress(pool,project,Number(events[0].id))).length,1);
 assert.equal((await appendPmTurnProgress(pool,{...event,attempt:2,sequence:2,kind:'message',text:'Печатаю ответ'})).accepted,true);
 assert.equal((await readPmTurnProgress(pool,project,Number(events[0].id))).length,2);
});
