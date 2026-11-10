import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import Fastify from 'fastify';
import pg from 'pg';
import {initProjectIterations,proposeIterationPlan,readIteration,registerProjectIterationRoutes,runIterationPlanning} from '../dist/project-iterations.js';
import {toolAllowedForRole} from '../dist/agent-tools.js';

test('iteration scope, preview and launch are separate, project-scoped decisions',async t=>{
 const db=new pg.Client({connectionString:process.env.DATABASE_URL});
 await db.connect();
 const app=Fastify();
 const schema='iteration_'+randomUUID().replaceAll('-','');
 await db.query('CREATE SCHEMA '+schema);
 await db.query('SET search_path TO '+schema+',public');
 t.after(async()=>{await app.close();await db.query('DROP SCHEMA '+schema+' CASCADE');await db.end();});
 await db.query(`
  CREATE TABLE users(id uuid PRIMARY KEY);
  CREATE TABLE projects(id uuid PRIMARY KEY);
  CREATE TABLE documents(id uuid PRIMARY KEY,project_id uuid REFERENCES projects(id),title text,body text DEFAULT '',system_key text,updated_at timestamptz DEFAULT now(),knowledge_status text DEFAULT 'approved');
  CREATE TABLE tasks(
   id uuid PRIMARY KEY,project_id uuid REFERENCES projects(id),title text,description text,type text,stage text,analysis_state text,
   parent_id uuid REFERENCES tasks(id),depends_on_task_id uuid REFERENCES tasks(id),dependency_source text,position int,git_branch text,pr_url text,
   display_number int DEFAULT 1,spec_version int DEFAULT 1,spec_reviewed_version int DEFAULT 1,spec_review_status text DEFAULT 'current',
   clarification_questions jsonb DEFAULT '[]'
  );
  CREATE TABLE project_ai_settings(project_id uuid PRIMARY KEY,enabled boolean);
  CREATE TABLE workflow_stages(project_id uuid,stage text,agent_instructions text);
  CREATE TABLE project_rules(project_id uuid,body text,created_at timestamptz DEFAULT now());
  CREATE TABLE process_events(id uuid PRIMARY KEY,project_id uuid,process_id uuid,process_kind text,stage text,detail text);
  CREATE TABLE task_events(id uuid PRIMARY KEY,task_id uuid REFERENCES tasks(id),actor_id uuid,event text,detail text);
  CREATE TABLE knowledge_task_links(id uuid PRIMARY KEY,project_id uuid,document_id uuid,task_id uuid,relation text,UNIQUE(project_id,document_id,task_id,relation));
 `);
 await initProjectIterations(db);
 const actor=randomUUID(),project=randomUUID(),other=randomUUID(),source=randomUUID(),foreignSource=randomUUID();
 await db.query('INSERT INTO users VALUES($1)',[actor]);
 await db.query('INSERT INTO projects VALUES($1),($2)',[project,other]);
 await db.query('INSERT INTO project_ai_settings VALUES($1,true)',[project]);
 await db.query("INSERT INTO documents(id,project_id,title) VALUES($1,$2,'ТЗ'),($3,$4,'Чужое ТЗ')",[source,project,foreignSource,other]);
 const pool={query:db.query.bind(db),connect:async()=>({query:db.query.bind(db),release(){}})};
 registerProjectIterationRoutes(app,{pool,uid:()=>actor,access:async()=>true,requireAdmin:async()=>true});
 const launchCalls=[];
 app.post('/api/projects/:id/tasks/:taskId/run-ai',async(req,reply)=>{
  launchCalls.push({id:req.params.taskId,...req.body});
  return reply.code(202).send({message:'В очереди'});
 });
 const path='/api/projects/'+project+'/iterations';
 const request=(method,url,payload)=>app.inject({method,url,payload});
 const create=await request('POST',path,{title:'MVP',body:'Первый рабочий сценарий',document_ids:[source]});
 assert.equal(create.statusCode,200,create.body);
 const {id}=create.json(),url=path+'/'+id;
 assert.equal((await request('GET','/api/projects/'+other+'/iterations/'+id)).statusCode,404);
 assert.equal((await request('POST',path,{title:'Чужой документ',body:'Scope',document_ids:[foreignSource]})).statusCode,400);
 const scope=await readIteration(db,project,id);
 const proposal={iteration_id:id,expected_revision:1,source_revision:scope.source_revision,
  epics:[{key:'checkout',title:'Оформление',description:'Базовый сценарий',tasks:[
   {key:'form',title:'Форма',description:'Ввод данных',kind:'development',tags:['UI','ui']},
   {key:'order',title:'Заказ',description:'Проверить правила',kind:'analysis',depends_on:'form'}
  ]}]};
 const propose=()=>proposeIterationPlan(db,project,actor,proposal);
 await assert.rejects(propose,{statusCode:409});
 assert.equal((await request('POST',url+'/approve',{expected_revision:1})).statusCode,200);
 assert.equal(toolAllowedForRole('analyst','iterations.prepare_plan'),true);
 assert.equal(toolAllowedForRole('analyst','iterations.recommend_launch'),false);
 const queued=await request('POST',url+'/prepare',{request:'Учти ручное оформление'});
 assert.equal(queued.statusCode,202,queued.body);
 const runId=queued.json().planning_run_id;
 assert.equal((await request('POST',url+'/prepare',{})).json().planning_run_id,runId);
 let calls=0;
 const complete=()=>runIterationPlanning(pool,runId,async(prompt,projectId)=>{
  calls++;
  assert.equal(projectId,project);
  assert.match(prompt,/Ты системный аналитик/);
  assert.match(prompt,/Ручное оформление/i);
  assert.match(prompt,/Первый рабочий сценарий/);
  return JSON.stringify({epics:proposal.epics});
 });
 await complete();
 await complete();
 assert.equal(calls,1,'Temporal retry does not regenerate a completed draft');
 const status=(await request('GET',url)).json();
 assert.equal(status.planning_runs[0].status,'completed');
 const plan=await propose();
 assert.equal(status.planning_runs[0].plan_id,plan.id);
 assert.deepEqual(await propose(),plan,'Identical content reuses the same draft');
 assert.equal((await db.query('SELECT count(*)::int n FROM tasks')).rows[0].n,0);
 const planUrl=url+'/plans/'+plan.id;
 const preview=(await request('GET',planUrl)).json();
 assert.equal(preview.items.length,3);
 const publish=(value=preview.preview_revision)=>request('POST',planUrl+'/publish',{confirm:true,preview_revision:value});
 await db.query("UPDATE documents SET updated_at=updated_at+interval '1 second' WHERE id=$1",[source]);
 assert.equal((await publish()).statusCode,409,'Changed source invalidates publication');
 proposal.source_revision=(await readIteration(db,project,id)).source_revision;
 const next=await propose(),nextUrl=url+'/plans/'+next.id;
 const nextPreview=(await request('GET',nextUrl)).json();
 const firstPublish=await request('POST',nextUrl+'/publish',{confirm:true,preview_revision:nextPreview.preview_revision});
 assert.equal(firstPublish.statusCode,200,firstPublish.body);
 const result=firstPublish.json();
 assert.equal(result.created.length,3);
 assert.deepEqual((await request('POST',nextUrl+'/publish',{confirm:true,preview_revision:nextPreview.preview_revision})).json(),result);
 const {tasks}=await readIteration(db,project,id);
 const epic=tasks.find(task=>task.type==='epic'),form=tasks.find(task=>task.title==='Форма'),order=tasks.find(task=>task.title==='Заказ');
 assert.equal(form.parent_id,epic.id);
 assert.deepEqual(form.tags,['ui']);
 assert.equal(order.depends_on_task_id,form.id);
 assert.equal(order.stage,'analysis');
 assert.equal((await db.query('SELECT count(*)::int n FROM knowledge_task_links')).rows[0].n,2);
 const rerun=await propose(),rerunUrl=url+'/plans/'+rerun.id;
 const rerunPreview=(await request('GET',rerunUrl)).json();
 assert.equal(rerunPreview.items.filter(item=>item.existing).length,3);
 assert.deepEqual((await request('POST',rerunUrl+'/publish',{confirm:true,preview_revision:rerunPreview.preview_revision})).json().created,[]);
 assert.equal((await request('POST',url+'/launch',{confirm:true,expected_revision:1,task_ids:[epic.id]})).statusCode,409);
 await db.query("UPDATE tasks SET analysis_state='ready_for_development' WHERE id=$1",[form.id]);
 const start=await request('POST',url+'/launch',{confirm:true,expected_revision:1,task_ids:[form.id,order.id]});
 assert.equal(start.statusCode,200,start.body);
 assert.deepEqual(start.json().results.map(item=>[item.id,item.started]),[[form.id,true],[order.id,false]]);
 assert.deepEqual(launchCalls,[{id:form.id,approveAnalysis:true,iterationApproval:{id,revision:1}}]);
 const tagUpdate=await request('PUT','/api/projects/'+project+'/tasks/'+form.id+'/planning',{iteration_id:id,tags:['Миграция','миграция']});
 assert.deepEqual(tagUpdate.json(),{iteration_id:id,tags:['миграция']});
 const change=await request('PUT',url,{title:'MVP 1',body:scope.body,document_ids:[source],expected_revision:1});
 assert.deepEqual(change.json(),{id,revision:2});
 assert.equal((await request('POST',url+'/approve',{expected_revision:2})).statusCode,200);
 assert.equal((await request('POST',url+'/launch',{confirm:true,expected_revision:1,task_ids:[form.id]})).statusCode,409);
});
