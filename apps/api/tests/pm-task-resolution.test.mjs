import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {resolvePmTaskReference} from '../dist/pm-task-resolution.js';
import {executeAgentTool} from '../dist/agent-tool-executor.js';
import {agentToolCatalog,toolsForRole} from '../dist/agent-tools.js';

test('PM safely resolves old human task numbers in the current project without relying on recent-task order',async()=>{
 const db=new pg.Client({connectionString:process.env.DATABASE_URL});await db.connect();
 try{
  await db.query('CREATE TEMP TABLE tasks(id uuid,project_id uuid,display_number int,title text,stage text)');
  const project=randomUUID(),otherProject=randomUUID(),id=randomUUID(),otherId=randomUUID();
  await db.query("INSERT INTO tasks VALUES($1,$2,36,'Скриншоты старого сайта','development'),($3,$4,36,'Чужая карточка','backlog')",
   [id,project,otherId,otherProject]);
  const actual=await resolvePmTaskReference(db,project,{task_number:36});
  assert.equal(actual.id,id);
  assert.equal(actual.display_number,36);
  assert.equal(actual.stage,'development');
  assert.equal((await resolvePmTaskReference(db,project,{task_id:id})).id,id);
  assert.equal((await resolvePmTaskReference(db,project,{task_id:id,task_number:36})).id,id);
  await assert.rejects(resolvePmTaskReference(db,project,{task_id:id,task_number:39}),error=>error.statusCode===409);
  await assert.rejects(resolvePmTaskReference(db,project,{task_id:otherId}),error=>error.statusCode===404);
  await assert.rejects(resolvePmTaskReference(db,otherProject,{task_number:39}),error=>error.statusCode===404);
  await assert.rejects(resolvePmTaskReference(db,project,{}),error=>error.statusCode===400);
 }finally{await db.end();}
});

test('task cancel/delete require owner source but accept an exact human number instead of a guessed UUID',()=>{
 const all=new Map(agentToolCatalog.map(t=>[t.name,t]));
 for(const name of ['tasks.cancel','tasks.delete','tasks.close','workflow.move_task']){
  const tool=all.get(name);
  assert.ok(tool,name);
  assert.ok('task_number' in tool.inputSchema.properties,name);
  assert.ok(tool.inputSchema.required.includes('source_message_id'),name);
  assert.ok(!tool.inputSchema.required.includes('task_id'),name);
 }
 assert.ok(toolsForRole('manager').some(t=>t.name==='tasks.cancel'));
 assert.ok(!toolsForRole('documentation').some(t=>t.name==='tasks.cancel'));
});

test('PM can request one old task by visible number without loading all 500 recent tasks',async()=>{
 const project=randomUUID(),task=randomUUID();
 const queries=[];
 const db={query:async(sql,args)=>{
  queries.push({sql,args});
  return {rows:[{id:task,display_number:36,title:'Старая задача',stage:'development'}],rowCount:1};
 }};
 const session={project_id:project,actor_id:randomUUID(),id:randomUUID(),role:'manager',status:'running'};
 const result=await executeAgentTool(db,session,'tasks.list',{display_number:36},async()=>{});
 assert.deepEqual(result.tasks.map(x=>x.display_number),[36]);
 assert.match(queries[0].sql,/display_number=\$2/);
 assert.deepEqual(queries[0].args,[project,36]);
});
